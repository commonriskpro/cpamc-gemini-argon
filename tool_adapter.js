function cleanGeminiOutput(text) {
  if (!text) return "";
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^(Gemini\s+(?:dijo|said)\s*[:\-–—]?\s*)/i, "");
  cleaned = cleaned.replace(/^(?:Code snippet|Fragmento de código)\s*/im, "");
  return cleaned.trim();
}

class SyntheticToolAdapter {
  constructor(options = {}) {
    this.tagOpen = options.tagOpen || "```tool_call";
    this.tagClose = options.tagClose || "```";
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
            let parsedArgs = args;
            try { parsedArgs = JSON.parse(args); } catch (e) {}
            return this.tagOpen + "\n" + JSON.stringify({ name: tc.function.name, arguments: parsedArgs }, null, 2) + "\n" + this.tagClose;
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
      "2. To invoke a tool, output a single fenced code block with the tag \"tool_call\":\n" +
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
    if (!rawText) return { role: "assistant", content: "", tool_calls: null, finish_reason: "stop" };

    // 1. Try explicit tag ```tool_call ... ```
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
      // 2. Try generic fenced block ```json ... ``` or ``` ... ```
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fenceMatch) {
        const candidate = fenceMatch[1].trim();
        if (candidate.startsWith("{") && candidate.endsWith("}")) {
          try {
            const p = JSON.parse(candidate);
            if (p && (p.name || p.tool_name)) {
              jsonStr = candidate;
              textBefore = rawText.substring(0, fenceMatch.index)
                .replace(/(?:Fragmento de código|Code snippet)\s*$/i, "")
                .trim();
              textAfter = rawText.substring(fenceMatch.index + fenceMatch[0].length).trim();
            }
          } catch (e) {}
        }
      }
    }

    // 3. Fallback: extract balanced JSON object anywhere (e.g. Gemini Web UI code snippet)
    if (!jsonStr) {
      const obj = this._extractFirstJsonObject(rawText);
      if (obj) {
        try {
          const testParse = JSON.parse(obj.jsonStr);
          if (testParse && typeof testParse === "object" && (testParse.name || testParse.tool_name)) {
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
        content: cleanGeminiOutput(rawText),
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
        content: cleanGeminiOutput(rawText),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    const toolName = parsedCall.name || parsedCall.tool_name;
    if (!toolName) {
      return {
        role: "assistant",
        content: cleanGeminiOutput(rawText),
        tool_calls: null,
        finish_reason: "stop"
      };
    }

    const commentary = [cleanGeminiOutput(textBefore), cleanGeminiOutput(textAfter)].filter(Boolean).join("\n");
    const callId = "call_" + Math.random().toString(36).substring(2, 11);
    const rawArgs = parsedCall.arguments !== undefined ? parsedCall.arguments : (parsedCall.parameters !== undefined ? parsedCall.parameters : {});
    const argsString = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);

    return {
      role: "assistant",
      content: commentary || null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: toolName,
            arguments: argsString
          }
        }
      ],
      finish_reason: "tool_calls"
    };
  }
}

module.exports = {
  SyntheticToolAdapter,
  cleanGeminiOutput
};
