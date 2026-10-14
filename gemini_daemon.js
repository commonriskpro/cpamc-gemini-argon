
const { SyntheticToolAdapter, cleanGeminiOutput } = require("./tool_adapter");

class BrowserDaemon {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentCredHash = null;
    this.idleTimer = null;
    this.isBusy = false;
    this.queue = [];
  }

  async initBrowser(credential, authuser) {
    const rawCookies = getBestCookies(parseCookiesInput(credential));
    if (!rawCookies || rawCookies.length === 0) {
      throw new Error("No Google session cookies provided");
    }

    const uStr = (authuser !== undefined && authuser !== null && authuser !== "") ? String(authuser) : "";
    const credHash = crypto.createHash("sha256").update(JSON.stringify(rawCookies) + ":" + uStr).digest("hex");

    if (this.browser && this.context && this.page && this.currentCredHash === credHash) {
      return; // Already initialized and warm
    }

    await this.closeBrowser();

    const execPath = findBrowserExecutable();
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    };
    if (execPath) launchOpts.executablePath = execPath;

    this.browser = await chromium.launch(launchOpts);
    this.context = await this.browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });

    await injectCookies(this.context, rawCookies);

    this.page = await this.context.newPage();
    const targetUrl = uStr ? `https://gemini.google.com/u/${uStr}/app` : "https://gemini.google.com/app";
    await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForTimeout(2000);

    let isSignedOut = await this.page.evaluate(() => {
      const text = document.body ? (document.body.innerText || "") : "";
      return document.body.classList.contains("viewer-signed-out") || text.includes("Sign in to save activity") || text.includes("Inicia sesion");
    });
    if (isSignedOut) {
      const fresh = getSafariGoogleCookies();
      if (fresh && fresh.length > 0) {
        await injectCookies(this.context, fresh);
        syncAuthFiles(fresh);
        await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.page.waitForTimeout(2000);
        isSignedOut = await this.page.evaluate(() => {
          const text = document.body ? (document.body.innerText || "") : "";
          return document.body.classList.contains("viewer-signed-out") || text.includes("Sign in to save activity") || text.includes("Inicia sesion");
        });
      }
      if (isSignedOut) {
        throw new Error("Google session expired or signed out. Please make sure you are signed into Google in Safari.");
      }
    }
    this.currentCredHash = credHash;
  }

  async executeTurn({ model, upstream_model, messages, tools, credential, authuser, email, reasoning_effort }) {
    this._resetIdleTimer();
    await this.initBrowser(credential, authuser);

    const requestedModel = model || "web-gemini/gemini-4-argon";
    const upstreamModel = upstream_model || "gemini-4-argon";

    try {
      const allAccounts = getAllArgonAccounts();
      const requestedAuthuser = Number(authuser !== undefined && authuser !== null ? authuser : 0);
      const candidateAccounts = [
        ...allAccounts.filter(a => a.authuser === requestedAuthuser),
        ...allAccounts.filter(a => a.authuser !== requestedAuthuser)
      ];
      if (candidateAccounts.length === 0) {
        candidateAccounts.push({ authuser: requestedAuthuser, email: email || "" });
      }

      let activeAccount = null;

      for (const acc of candidateAccounts) {
        const uStr = acc.authuser ? String(acc.authuser) : "";
        const targetUrl = uStr ? `https://gemini.google.com/u/${uStr}/app` : "https://gemini.google.com/app";

        const currentUrl = this.page.url();
        const expectedPattern = uStr ? `/u/${uStr}/app` : "/app";
        if (!currentUrl.includes(expectedPattern)) {
          await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await this.page.waitForTimeout(1200);
        }

        const switcher = await this.page.waitForSelector(".input-area-switch", { timeout: 6000 }).catch(() => null);
        if (!switcher) continue;

        const currentText = (await switcher.innerText().catch(() => "")).trim();
        const targetSubstring = "Argon";

        if (currentText.includes(targetSubstring)) {
          activeAccount = acc;
          recordAccountStatus(acc.email, acc.authuser, false, null);
          break;
        }

        await switcher.click();
        await this.page.waitForTimeout(400);
        const option = await this.page.waitForSelector("[role='menuitem']:has-text('" + targetSubstring + "')", { timeout: 3000 }).catch(() => null);
        if (!option) continue;

        const optionInfo = await option.evaluate(el => {
          const text = (el.innerText || "").trim();
          const isDis = el.classList.contains("disabled") ||
                       Boolean(el.querySelector(".disabled")) ||
                       text.toLowerCase().includes("límite se restablece") ||
                       text.toLowerCase().includes("limit reset");
          return { isDis, text };
        }).catch(() => ({ isDis: true, text: "" }));

        if (optionInfo.isDis) {
          let resetTime = "";
          const m = optionInfo.text.match(/(?:restablece|resets?)\\s+(?:el\\s+)?([^\\n]+)/i);
          if (m) resetTime = m[1].trim();
          console.log(`[AutoBalancer] Account ${acc.email || "u/" + acc.authuser} rate-limited (${resetTime || "active limit"}). Rotating to next account...`);
          recordAccountStatus(acc.email, acc.authuser, true, resetTime);
          // Close popup before continuing
          await this.page.keyboard.press("Escape").catch(() => {});
          continue;
        }

        await this.page.evaluate(el => el.click(), option);
        await this.page.waitForTimeout(600);
        activeAccount = acc;
        recordAccountStatus(acc.email, acc.authuser, false, null);
        break;
      }

      if (!activeAccount) {
        throw new Error("All connected Google accounts have reached their Gemini 4 Argon quota limits.");
      }

      // Reasoning effort handling
      if (reasoning_effort) {
        const effort = String(reasoning_effort).toLowerCase();
        let targetEffort = "";
        if (effort === "low") targetEffort = "Low";
        else if (effort === "medium") targetEffort = "Medium";
        else if (effort === "high" || effort === "xhigh" || effort === "max") targetEffort = "High";

        if (targetEffort) {
          try {
            const switcher = await this.page.waitForSelector(".input-area-switch", { timeout: 3000 }).catch(() => null);
            if (switcher) {
              await switcher.click();
              await this.page.waitForTimeout(400);
              const thinkingMenu = await this.page.waitForSelector("[role='menuitem']:has-text('Thinking'), [role='menuitem']:has-text('Pensamiento'), [role='menuitem']:has-text('Nivel de pensamiento')", { timeout: 3000 }).catch(() => null);
              if (thinkingMenu) {
                await thinkingMenu.click();
                await this.page.waitForTimeout(400);
                const effortOption = await this.page.waitForSelector(`[role='menuitem']:has-text('${targetEffort}')`, { timeout: 3000 }).catch(() => null);
                if (effortOption) {
                  await effortOption.click();
                  await this.page.waitForTimeout(400);
                }
              }
            }
          } catch (err) {}
        }
      }

      const hasTools = Array.isArray(tools) && tools.length > 0;
      const adapter = new SyntheticToolAdapter();
      let promptText = "";
      if (hasTools) {
        promptText = adapter.buildPrompt({ messages, tools });
      } else {
        const userMsgs = messages.filter(m => m.role === "user");
        if (messages.length === 1 && userMsgs.length === 1) {
          promptText = adapter._extractMessageText(userMsgs[0].content);
        } else {
          promptText = messages.map(m => (m.role === "assistant" ? "Assistant: " : m.role === "user" ? "User: " : "System: ") + adapter._extractMessageText(m.content)).join("\n\n") + "\n\nAssistant:";
        }
      }

      const editor = await this.page.waitForSelector(".ql-editor, [contenteditable='true']", { timeout: 15000 });
      await editor.click();

      await this.page.evaluate((t) => {
        const el = document.querySelector(".ql-editor, [contenteditable='true']");
        el.focus();
        document.execCommand("insertText", false, t);
      }, promptText);

      await this.page.waitForTimeout(300);

      const sendBtn = await this.page.$("button[aria-label*='Send'], button[aria-label*='Enviar'], .send-button");
      if (sendBtn && await sendBtn.isEnabled()) {
        await sendBtn.click();
      } else {
        await this.page.keyboard.press("Enter");
      }

      // Response Extraction from DOM
      await this.page.waitForSelector("model-response, .presented-response-container", { timeout: 15000 });

      const pollStart = Date.now();
      const maxTimeoutMs = 70000;
      let rawResponseText = "";

      while (Date.now() - pollStart < maxTimeoutMs) {
        const stopBtn = await this.page.$("button[aria-label*='Stop'], button[aria-label*='Detener'], [aria-label*='Detener respuesta'], .stop-button");
        const isGenerating = stopBtn !== null && (await stopBtn.isVisible().catch(() => false));

        const currentText = await this.page.evaluate(() => {
          const responses = document.querySelectorAll("model-response, .presented-response-container");
          if (!responses.length) return "";
          const lastResponse = responses[responses.length - 1];
          const contentEl = lastResponse.querySelector("message-content, .markdown, .model-response-text") || lastResponse;
          return contentEl ? (contentEl.innerText || "").trim() : "";
        });

        if (!isGenerating && currentText.length > 0) {
          await this.page.waitForTimeout(500);
          const settledText = await this.page.evaluate(() => {
            const responses = document.querySelectorAll("model-response, .presented-response-container");
            if (!responses.length) return "";
            const lastResponse = responses[responses.length - 1];
            const contentEl = lastResponse.querySelector("message-content, .markdown, .model-response-text") || lastResponse;
            return contentEl ? (contentEl.innerText || "").trim() : "";
          });
          rawResponseText = settledText || currentText;
          break;
        }

        await this.page.waitForTimeout(500);
      }

      if (!rawResponseText) {
        rawResponseText = await this.page.evaluate(() => {
          const responses = document.querySelectorAll("model-response, .presented-response-container");
          if (!responses.length) return "";
          const lastResponse = responses[responses.length - 1];
          const contentEl = lastResponse.querySelector("message-content, .markdown, .model-response-text") || lastResponse;
          return contentEl ? (contentEl.innerText || "").trim() : "";
        });
      }

      const cleanText = cleanGeminiOutput(rawResponseText);
      if (!cleanText) {
        throw new Error("No response text captured from Gemini Web within 70s timeout");
      }

      let finalChoice = {};

      if (hasTools) {
        const parsed = adapter.parseResponse(cleanText);
        finalChoice = {
          index: 0,
          message: {
            role: "assistant",
            content: parsed.content,
            tool_calls: parsed.tool_calls
          },
          finish_reason: parsed.finish_reason
        };
      } else {
        finalChoice = {
          index: 0,
          message: {
            role: "assistant",
            content: cleanText.trim()
          },
          finish_reason: "stop"
        };
      }

      return {
        id: "chatcmpl-gw-" + crypto.randomUUID().slice(0, 12),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [finalChoice],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    } finally {
      this._resetIdleTimer();
    }
  }

  async closeBrowser() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.context = null;
      this.page = null;
      this.currentCredHash = null;
    }
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      console.log("[GeminiDaemon] Inactivity threshold reached. Suspending browser to free RAM...");
      await this.closeBrowser();
    }, IDLE_TIMEOUT_MS);
  }
}

const daemon = new BrowserDaemon();

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", browser_active: Boolean(daemon.browser) }));
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "shutting_down" }));
    await daemon.closeBrowser();
    process.exit(0);
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    let bodyStr = "";
    req.on("data", chunk => { bodyStr += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(bodyStr);
        const result = await daemon.executeTurn(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found\n");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[GeminiDaemon] Listening on http://127.0.0.1:" + PORT);
});

process.on("SIGINT", async () => {
  await daemon.closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await daemon.closeBrowser();
  process.exit(0);
});
