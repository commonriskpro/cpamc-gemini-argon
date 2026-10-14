const path = require("path");
const fs = require("fs");
const candidateNodeDirs = [
  path.join(__dirname, "node_modules"),
  path.join(process.env.HOME || "", ".cli-proxy-api", "plugins", "node_modules"),
  "/Users/saturno/Developer/plugin/node_modules",
  "/Users/saturno/Developer/plugin/web-accounts/node_modules",
  "/Users/saturno/Developer/cpamc-gemini-argon/node_modules",
  "/usr/local/lib/node_modules",
  "/opt/homebrew/lib/node_modules"
];
for (const dir of candidateNodeDirs) {
  if (fs.existsSync(dir) && !module.paths.includes(dir)) {
    module.paths.unshift(dir);
  }
}

/**
 * Gemini Web Headless Runner for CPAMC web-accounts native plugin.
 * Executes turns via Google Chrome headless + Playwright without GUI windows.
 */

const { getBestCookies, injectCookies, getSafariGoogleCookies, syncAuthFiles, recordAccountStatus, getAllArgonAccounts, getArgonStatus } = require("./cookie_sync");
const { chromium } = require("playwright-core");
const crypto = require("crypto");

const { SyntheticToolAdapter, cleanGeminiOutput } = require("./tool_adapter");

function parseCookiesInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {}
    }
    // Parse "name=value; name2=value2"
    return trimmed.split(";").map(part => {
      const idx = part.indexOf("=");
      if (idx === -1) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain: ".google.com",
        path: "/",
        secure: true
      };
    }).filter(Boolean);
  }
  return [];
}

async function main() {
  const stdinBuffer = fs.readFileSync(0, "utf8");
  if (!stdinBuffer || !stdinBuffer.trim()) {
    console.error(JSON.stringify({ error: "Empty request payload" }));
    process.exit(1);
  }

  let request;
  try {
    request = JSON.parse(stdinBuffer);
  } catch (err) {
    console.error(JSON.stringify({ error: "Invalid JSON input: " + err.message }));
    process.exit(1);
  }

  const requestedModel = request.model || "web-gemini/gemini-4-argon";
  const upstreamModel = request.upstream_model || "gemini-4-argon";
  const messages = request.messages || [];
  const tools = request.tools || [];
  const credential = request.credential || "";

  const rawCookies = getBestCookies(parseCookiesInput(credential));
  if (!rawCookies || rawCookies.length === 0) {
    console.error(JSON.stringify({ error: "No Google session cookies provided" }));
    process.exit(1);
  }

  function findBrowserExecutable() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const candidates = [];
    if (process.platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      );
    } else if (process.platform === 'linux') {
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium'
      );
    } else if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      );
    }
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

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
  let browser = null;

  const cleanup = async () => {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
      browser = null;
    }
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    browser = await chromium.launch(launchOpts);

    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });

    await injectCookies(ctx, rawCookies);

    const page = await ctx.newPage();

    const authuser = (request.authuser !== undefined && request.authuser !== null && request.authuser !== "")
      ? String(request.authuser)
      : "";
    const targetUrl = authuser ? `https://gemini.google.com/u/${authuser}/app` : "https://gemini.google.com/app";

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    let isSignedOut = await page.evaluate(() => {
      const text = document.body ? (document.body.innerText || "") : "";
      return document.body.classList.contains("viewer-signed-out") || text.includes("Sign in to save activity") || text.includes("Inicia sesion");
    });
    if (isSignedOut) {
      const fresh = getSafariGoogleCookies();
      if (fresh && fresh.length > 0) {
        await injectCookies(ctx, fresh);
        syncAuthFiles(fresh);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
        isSignedOut = await page.evaluate(() => {
          const text = document.body ? (document.body.innerText || "") : "";
          return document.body.classList.contains("viewer-signed-out") || text.includes("Sign in to save activity") || text.includes("Inicia sesion");
        });
      }
      if (isSignedOut) {
        throw new Error("Google session expired or signed out. Please make sure you are signed into Google in Safari.");
      }
    }

    // Intelligent Multi-Account Selection with Auto-Failover
    const allAccounts = getAllArgonAccounts();
    const requestedAuthuser = Number(request.authuser !== undefined && request.authuser !== null ? request.authuser : 0);
    const candidateAccounts = [
      ...allAccounts.filter(a => a.authuser === requestedAuthuser),
      ...allAccounts.filter(a => a.authuser !== requestedAuthuser)
    ];
    if (candidateAccounts.length === 0) {
      candidateAccounts.push({ authuser: requestedAuthuser, email: request.email || "" });
    }

    let activeAccount = null;

    for (const acc of candidateAccounts) {
      const uStr = acc.authuser ? String(acc.authuser) : "";
      const targetUrl = uStr ? `https://gemini.google.com/u/${uStr}/app` : "https://gemini.google.com/app";

      const currentUrl = page.url();
      const expectedPattern = uStr ? `/u/${uStr}/app` : "/app";
      if (!currentUrl.includes(expectedPattern)) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1200);
      }

      const switcher = await page.waitForSelector(".input-area-switch", { timeout: 6000 }).catch(() => null);
      if (!switcher) continue;

      const currentText = (await switcher.innerText().catch(() => "")).trim();
      const targetSubstring = "Argon";

      if (currentText.includes(targetSubstring)) {
        activeAccount = acc;
        recordAccountStatus(acc.email, acc.authuser, false, null);
        break;
      }

      await switcher.click();
      await page.waitForTimeout(400);
      const option = await page.waitForSelector("[role='menuitem']:has-text('" + targetSubstring + "')", { timeout: 3000 }).catch(() => null);
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
        await page.keyboard.press("Escape").catch(() => {});
        continue;
      }

      await page.evaluate(el => el.click(), option);
      await page.waitForTimeout(600);
      activeAccount = acc;
      recordAccountStatus(acc.email, acc.authuser, false, null);
      break;
    }

    if (!activeAccount) {
      throw new Error("All connected Google accounts have reached their Gemini 4 Argon quota limits.");
    }

    // Apply reasoning effort if requested
    if (request.reasoning_effort) {
      const effort = String(request.reasoning_effort).toLowerCase();
      let targetEffort = "";
      if (effort === "low") targetEffort = "Low";
      else if (effort === "medium") targetEffort = "Medium";
      else if (effort === "high" || effort === "xhigh" || effort === "max") targetEffort = "High";

      if (targetEffort) {
        try {
          const switcher = await page.waitForSelector(".input-area-switch", { timeout: 3000 }).catch(() => null);
          if (switcher) {
            await switcher.click();
            await page.waitForTimeout(400);
            const thinkingMenu = await page.waitForSelector("[role='menuitem']:has-text('Thinking'), [role='menuitem']:has-text('Pensamiento'), [role='menuitem']:has-text('Nivel de pensamiento')", { timeout: 3000 }).catch(() => null);
            if (thinkingMenu) {
              await thinkingMenu.click();
              await page.waitForTimeout(400);
              const effortOption = await page.waitForSelector(`[role='menuitem']:has-text('${targetEffort}')`, { timeout: 3000 }).catch(() => null);
              if (effortOption) {
                await effortOption.click();
                await page.waitForTimeout(400);
              }
            }
          }
        } catch (err) {}
      }
    }

    // Build prompt
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const adapter = new SyntheticToolAdapter();
    let promptText = "";
    if (hasTools) {
      promptText = adapter.buildPrompt({ messages, tools });
    } else {
      // Simple multi-turn transcript
      const userMsgs = messages.filter(m => m.role === "user");
      if (messages.length === 1 && userMsgs.length === 1) {
        promptText = adapter._extractMessageText(userMsgs[0].content);
      } else {
        promptText = messages.map(m => (m.role === "assistant" ? "Assistant: " : m.role === "user" ? "User: " : "System: ") + adapter._extractMessageText(m.content)).join("\n\n") + "\n\nAssistant:";
      }
    }

    const editor = await page.waitForSelector(".ql-editor, [contenteditable='true']", { timeout: 15000 });
    await editor.click();

    await page.evaluate((t) => {
      const el = document.querySelector(".ql-editor, [contenteditable='true']");
      if (el) {
        el.focus();
        document.execCommand("insertText", false, t);
      }
    }, promptText);

    await page.waitForTimeout(400);

    const sendBtn = await page.$("button[aria-label*='Send'], button[aria-label*='Enviar'], .send-button");
    if (sendBtn && (await sendBtn.isEnabled().catch(() => false))) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Response Extraction from DOM
    await page.waitForSelector("model-response, .presented-response-container", { timeout: 15000 });

    const pollStart = Date.now();
    const maxTimeoutMs = 70000;
    let rawResponseText = "";

    while (Date.now() - pollStart < maxTimeoutMs) {
      const stopBtn = await page.$("button[aria-label*='Stop'], button[aria-label*='Detener'], [aria-label*='Detener respuesta'], .stop-button");
      const isGenerating = stopBtn !== null && (await stopBtn.isVisible().catch(() => false));

      const currentText = await page.evaluate(() => {
        const responses = document.querySelectorAll("model-response, .presented-response-container");
        if (!responses.length) return "";
        const lastResponse = responses[responses.length - 1];
        const contentEl = lastResponse.querySelector("message-content, .markdown, .model-response-text") || lastResponse;
        return contentEl ? (contentEl.innerText || "").trim() : "";
      });

      if (!isGenerating && currentText.length > 0) {
        await page.waitForTimeout(500);
        const settledText = await page.evaluate(() => {
          const responses = document.querySelectorAll("model-response, .presented-response-container");
          if (!responses.length) return "";
          const lastResponse = responses[responses.length - 1];
          const contentEl = lastResponse.querySelector("message-content, .markdown, .model-response-text") || lastResponse;
          return contentEl ? (contentEl.innerText || "").trim() : "";
        });
        rawResponseText = settledText || currentText;
        break;
      }

      await page.waitForTimeout(500);
    }

    if (!rawResponseText) {
      rawResponseText = await page.evaluate(() => {
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

    const completion = {
      id: "chatcmpl-gw-" + crypto.randomUUID().slice(0, 12),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [finalChoice],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    console.log(JSON.stringify(completion));
  } finally {
    await cleanup();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
