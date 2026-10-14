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

const { chromium } = require("playwright-core");
const crypto = require("crypto");

class SyntheticToolAdapter {
  constructor(options = {}) {
    this.tagOpen = options.tagOpen || "```tool_call";
    this.tagClose = options.tagClose || "```";
  }

  _extractMessageText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(part => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (content && typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  }

  buildPrompt({ messages, tools, systemInstruction = "" }) {
    let promptParts = [];
    if (tools && tools.length > 0) {
      promptParts.push(this._buildToolContract(tools));
    }
    if (systemInstruction) {
      promptParts.push("[SYSTEM INSTRUCTION]\n" + systemInstruction + "\n");
    }
    promptParts.push("[CONVERSATION HISTORY]");
    for (const msg of messages) {
      const text = this._extractMessageText(msg.content);
      if (msg.role === "system") {
        promptParts.push("System: " + text);
      } else if (msg.role === "user") {
        promptParts.push("User: " + text);
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const callsFormatted = msg.tool_calls.map(tc => {
            const args = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            return this.tagOpen + "\n" + JSON.stringify({ name: tc.function.name, arguments: JSON.parse(args) }, null, 2) + "\n" + this.tagClose;
          }).join("\n");
          promptParts.push("Assistant (Tool Action):\n" + callsFormatted);
        } else {
          promptParts.push("Assistant: " + text);
        }
      } else if (msg.role === "tool") {
        promptParts.push("Tool Output [id: " + (msg.tool_call_id || "default") + "]:\n" + text);
      }
    }
    promptParts.push("\nAssistant:");
    return promptParts.join("\n\n");
  }

  _buildToolContract(tools) {
    const toolsFormatted = tools.map((t, idx) => {
      const fn = t.function || t;
      return "Tool #" + (idx + 1) + ": " + fn.name + "\n" +
             "Description: " + (fn.description || "No description provided.") + "\n" +
             "Parameters JSON Schema:\n" + JSON.stringify(fn.parameters || {}, null, 2);
    }).join("\n\n-------------------\n\n");

    return "[ENVIRONMENT & TOOL CALLING CAPABILITIES]\n" +
      "You are acting as an autonomous engineering agent within the Codex workspace.\n" +
      "You have access to the following workspace tools:\n\n" +
      "-------------------\n" + toolsFormatted + "\n-------------------\n\n" +
      "[TOOL CALLING PROTOCOL]\n" +
      "1. If you need to inspect files, execute shell commands, read logs, or apply changes, you MUST invoke a tool.\n" +
      "2. To invoke a tool, output a single fenced code block with the exact tag \"tool_call\":\n" +
      "```tool_call\n" +
      "{\n" +
      '  "name": "<tool_name>",\n' +
      '  "arguments": {\n' +
      '    "<param_key>": "<param_value>"\n' +
      "  }\n" +
      "}\n" +
      "```\n" +
      "3. Do NOT invent tool names. Use ONLY the tools declared above.\n" +
      "4. If you do NOT need to call a tool (e.g. final answer, conceptual explanation, or asking the user), simply reply in natural text without the ```tool_call block.\n" +
      "5. Output the tool call block immediately without unnecessary conversational preamble.";
  }

  _extractFirstJsonObject(text) {
    const startIdx = text.indexOf("{");
    if (startIdx === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            return {
              jsonStr: text.slice(startIdx, i + 1),
              startIndex: startIdx,
              endIndex: i + 1
            };
          }
        }
      }
    }
    return null;
  }

  parseResponse(rawText) {
    const regex = new RegExp(this.escapeRegex(this.tagOpen) + "\\s*([\\s\\S]*?)\\s*" + this.escapeRegex(this.tagClose), "i");
    const match = rawText.match(regex);
    let jsonStr = null;
    let textBefore = "";
    let textAfter = "";

    if (match) {
      jsonStr = match[1].trim();
      textBefore = rawText.substring(0, match.index).trim();
      textAfter = rawText.substring(match.index + match[0].length).trim();
    } else {
      const obj = this._extractFirstJsonObject(rawText);
      if (obj) {
        try {
          const testParse = JSON.parse(obj.jsonStr);
          if (testParse && typeof testParse === "object" && testParse.name) {
            jsonStr = obj.jsonStr;
            textBefore = rawText.substring(0, obj.startIndex)
              .replace(/(?:Fragmento de código|Code snippet)\s*$/i, "")
              .trim();
            textAfter = rawText.substring(obj.endIndex).trim();
          }
        } catch (e) {}
      }
    }

    if (!jsonStr) {
      return {
        role: "assistant",
        content: rawText.trim(),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    let parsedCall = null;
    try {
      parsedCall = JSON.parse(jsonStr);
    } catch (e) {
      return {
        role: "assistant",
        content: rawText.trim(),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    if (!parsedCall || !parsedCall.name) {
      return {
        role: "assistant",
        content: rawText.trim(),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    const commentary = [textBefore, textAfter].filter(Boolean).join("\n");

    const callId = "call_" + Math.random().toString(36).substring(2, 11);
    const argsString = typeof parsedCall.arguments === "string" ? parsedCall.arguments : JSON.stringify(parsedCall.arguments || {});

    return {
      role: "assistant",
      content: commentary || null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: parsedCall.name,
            arguments: argsString
          }
        }
      ],
      finish_reason: "tool_calls"
    };
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

function cleanGeminiOutput(text) {
  if (!text) return "";
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^(Gemini\s+(?:dijo|said)\s*[:\-–—]?\s*)/i, "").trim();
  return cleaned;
}

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

  const rawCookies = parseCookiesInput(credential);
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

    // Inject cookies
    for (const c of rawCookies) {
      if (!c.name || typeof c.value !== "string" || c.name.startsWith("__Host-") || c.name === "AEC" || c.name === "NID") continue;
      let domain = c.domain || ".google.com";
      if (!domain.startsWith(".")) domain = "." + domain;
      let secure = Boolean(c.secure);
      if (c.name.startsWith("__Secure-")) secure = true;

      try {
        await ctx.addCookies([{
          name: c.name,
          value: c.value,
          domain,
          path: c.path || "/",
          secure,
          httpOnly: Boolean(c.httpOnly)
        }]);
      } catch (e) {}
    }

    const page = await ctx.newPage();

    const authuser = (request.authuser !== undefined && request.authuser !== null && request.authuser !== "")
      ? String(request.authuser)
      : "";
    const targetUrl = authuser ? `https://gemini.google.com/u/${authuser}/app` : "https://gemini.google.com/app";

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const isSignedOut = await page.evaluate(() => {
      const text = document.body ? (document.body.innerText || "") : "";
      return document.body.classList.contains("viewer-signed-out") || text.includes("Sign in to save activity") || text.includes("Inicia sesion");
    });
    if (isSignedOut) {
      throw new Error("Google session expired or signed out. Please log into gemini.google.com in your browser and update the CPAMC auth credentials.");
    }

    // Model selection if requested
    const switcher = await page.waitForSelector(".input-area-switch", { timeout: 8000 }).catch(() => null);
    if (switcher) {
      const currentSwitcherText = (await switcher.innerText().catch(() => "")).trim();

      let targetModeSubstring = "";
      if (upstreamModel.includes("argon") || upstreamModel.includes("4")) {
        targetModeSubstring = "Argon";
      } else if (upstreamModel.includes("pro")) {
        targetModeSubstring = "Pro";
      } else if (upstreamModel.includes("flash-lite")) {
        targetModeSubstring = "Flash-Lite";
      } else if (upstreamModel.includes("flash")) {
        targetModeSubstring = "Flash";
      }

      if (targetModeSubstring) {
        if (!currentSwitcherText.includes(targetModeSubstring)) {
          try {
            await switcher.click();
            await page.waitForTimeout(600);
            const option = await page.waitForSelector("[role='menuitem']:has-text('" + targetModeSubstring + "')", { timeout: 4000 }).catch(() => null);
            if (option) {
              const isDis = await option.evaluate(el => {
                const text = (el.innerText || "").toLowerCase();
                return el.classList.contains("disabled") ||
                       Boolean(el.querySelector(".disabled")) ||
                       text.includes("límite se restablece") ||
                       text.includes("limit reset");
              }).catch(() => false);
              if (isDis) {
                throw new Error("Gemini 4 Argon is rate-limited or disabled on " + (request.email || ("authuser " + authuser)));
              }
              await page.evaluate(el => el.click(), option);
              await page.waitForTimeout(1000);
            }
          } catch (err) {
            if (err.message && err.message.includes("rate-limited or disabled")) {
              throw err;
            }
          }
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
              await switcher.click();
              await page.waitForTimeout(500);
              const thinkingMenu = await page.waitForSelector("[role='menuitem']:has-text('Thinking'), [role='menuitem']:has-text('Pensamiento'), [role='menuitem']:has-text('Nivel de pensamiento')", { timeout: 3000 }).catch(() => null);
              if (thinkingMenu) {
                await thinkingMenu.click();
                await page.waitForTimeout(500);
                const effortOption = await page.waitForSelector(`[role='menuitem']:has-text('${targetEffort}')`, { timeout: 3000 }).catch(() => null);
                if (effortOption) {
                  await effortOption.click();
                  await page.waitForTimeout(500);
                }
              }
            } catch (err) {}
          }
        }
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
