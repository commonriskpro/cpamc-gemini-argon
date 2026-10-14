/**
 * Gemini Web Headless Runner for CPAMC web-accounts native plugin.
 * Executes turns via Google Chrome headless + Playwright without GUI windows.
 */

const { chromium } = require("playwright-core");
const fs = require("fs");
const crypto = require("crypto");

class SyntheticToolAdapter {
  constructor(options = {}) {
    this.tagOpen = options.tagOpen || "```tool_call";
    this.tagClose = options.tagClose || "```";
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
      if (msg.role === "system") {
        promptParts.push("System: " + (msg.content || ""));
      } else if (msg.role === "user") {
        promptParts.push("User: " + (msg.content || ""));
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const callsFormatted = msg.tool_calls.map(tc => {
            const args = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            return this.tagOpen + "\n" + JSON.stringify({ name: tc.function.name, arguments: JSON.parse(args) }, null, 2) + "\n" + this.tagClose;
          }).join("\n");
          promptParts.push("Assistant (Tool Action):\n" + callsFormatted);
        } else {
          promptParts.push("Assistant: " + (msg.content || ""));
        }
      } else if (msg.role === "tool") {
        promptParts.push("Tool Output [id: " + (msg.tool_call_id || "default") + "]:\n" + (msg.content || ""));
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

  parseResponse(rawText) {
    const regex = new RegExp(this.escapeRegex(this.tagOpen) + "\\s*([\\s\\S]*?)\\s*" + this.escapeRegex(this.tagClose), "i");
    const match = rawText.match(regex);

    if (!match) {
      return {
        role: "assistant",
        content: rawText.trim(),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    const jsonStr = match[1].trim();
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

    const textBefore = rawText.substring(0, match.index).trim();
    const textAfter = rawText.substring(match.index + match[0].length).trim();
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

function parseStreamResponse(raw) {
  const lines = raw.split(/\r?\n/);
  let lastText = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter(c => typeof c === "string").join("");
      if (text) lastText = text;
    } catch (e) {}
  }
  return lastText;
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
  const browser = await chromium.launch(launchOpts);

  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15"
  });

  // Inject cookies
  for (const c of rawCookies) {
    if (!c.name || typeof c.value !== "string" || c.name.startsWith("__Host-")) continue;
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
  let streamRaw = "";
  let resolveDone;
  const donePromise = new Promise(res => { resolveDone = res; });

  page.on("response", async (resp) => {
    if (resp.url().includes("BardFrontendService/StreamGenerate")) {
      try {
        streamRaw = await resp.text();
        resolveDone();
      } catch (e) {}
    }
  });

  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Model selection if requested
  const switcher = await page.waitForSelector(".input-area-switch", { timeout: 15000 });
  const currentSwitcherText = (await switcher.innerText()).trim();

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

  if (targetModeSubstring && !currentSwitcherText.includes(targetModeSubstring)) {
    try {
      await switcher.click();
      await page.waitForTimeout(600);
      const option = await page.waitForSelector("[role='menuitem']:has-text('" + targetModeSubstring + "')", { timeout: 4000 });
      if (option) {
        await page.evaluate(el => el.click(), option);
        await page.waitForTimeout(1000);
      }
    } catch (err) {
      // If mode switcher fails, proceed with default active mode
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
      promptText = userMsgs[0].content || "";
    } else {
      promptText = messages.map(m => (m.role === "assistant" ? "Assistant: " : m.role === "user" ? "User: " : "System: ") + (m.content || "")).join("\n\n") + "\n\nAssistant:";
    }
  }

  const editor = await page.waitForSelector(".ql-editor, [contenteditable='true']", { timeout: 15000 });
  await editor.click();

  await page.evaluate((t) => {
    const el = document.querySelector(".ql-editor, [contenteditable='true']");
    el.focus();
    document.execCommand("insertText", false, t);
  }, promptText);

  await page.waitForTimeout(400);

  const sendBtn = await page.$("button[aria-label*='Send'], button[aria-label*='Enviar'], .send-button");
  if (sendBtn && await sendBtn.isEnabled()) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await Promise.race([
    donePromise,
    page.waitForTimeout(40000)
  ]);

  if (!streamRaw) {
    await browser.close();
    console.error(JSON.stringify({ error: "No StreamGenerate response received from Gemini Web" }));
    process.exit(1);
  }

  const rawOutputText = parseStreamResponse(streamRaw);
  let finalChoice = {};

  if (hasTools) {
    const parsed = adapter.parseResponse(rawOutputText);
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
        content: rawOutputText.trim()
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

  await browser.close();
  console.log(JSON.stringify(completion));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
