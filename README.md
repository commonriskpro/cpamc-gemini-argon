# CPAMC Gemini 4 Argon Plugin (`cpamc-gemini-argon`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go)](https://golang.org)
[![Playwright](https://img.shields.io/badge/Playwright-Headless-2EAD33?logo=playwright)](https://playwright.dev)
[![Codex Compatible](https://img.shields.io/badge/Codex-Compatible-000000)](https://github.com)

A lean, zero-bloat native C-ABI plugin for **CLIProxyAPI (CPAMC)** that unlocks **Gemini 4 Argon** with autonomous synthetic tool calling, multi-account rotation, and streaming reasoning chunks directly inside Codex.

---

## Key Highlights

- **Dedicated to Gemini 4 Argon**: 100% focused on Google's flagship reasoning model without legacy bloat.
- **Autonomous Synthetic Tool Calling**: Translates OpenAI/Codex tool schemas into ReAct protocol, executes browser/bash/file inspection turns, and outputs native `tool_calls` back to Codex.
- **BotGuard Bypass**: Driven via Playwright-core with headless Chromium/Chrome without GUI windows or desktop interruptions.
- **Multi-Account Rotation**: Connect multiple Google accounts into CPAMC auths for automatic load balancing and quota management.
- **Cross-Platform**: First-class support for **macOS** (Apple Silicon `arm64`), **Linux** (`amd64` and `arm64`), and **Windows** (`amd64`).

---

## Architecture

```
   +-----------------------------------------------------------+
   |                    Codex Desktop Client                   |
   +-----------------------------------------------------------+
                                 |
                        HTTP / SSE (port 8317)
                                 v
   +-----------------------------------------------------------+
   |               CLIProxyAPI (CPAMC Gateway)                 |
   +-----------------------------------------------------------+
                                 |
                      Native C-ABI (plugin.call)
                                 v
   +-----------------------------------------------------------+
   |        cpamc-gemini-argon (.dylib / .so plugin)          |
   +-----------------------------------------------------------+
                                 |
                      IPC Subprocess / JSON Stdin
                                 v
   +-----------------------------------------------------------+
   |            gemini_runner.js (Playwright-core)             |
   |  * SyntheticToolAdapter (ReAct <-> OpenAI tool_calls)     |
   |  * Cookie Session Injection                               |
   |  * Headless Chrome / Chromium                             |
   +-----------------------------------------------------------+
                                 |
                      HTTPS (StreamGenerate RPC)
                                 v
   +-----------------------------------------------------------+
   |            Google Gemini Web (gemini.google.com)          |
   |                    [Gemini 4 Argon]                       |
   +-----------------------------------------------------------+
```

---

## Installation

### 1. Prerequisites

- **Node.js** (v18 or newer):
  ```bash
  # macOS
  brew install node

  # Linux (Ubuntu / Debian)
  sudo apt-get install -y nodejs npm
  ```

- **Google Chrome or Chromium**:
  ```bash
  # Linux (Ubuntu / Debian)
  sudo apt-get install -y chromium-browser
  # or
  sudo apt-get install -y google-chrome-stable
  ```

- **Playwright Core** (in your CPAMC plugins directory):
  ```bash
  cd ~/.cli-proxy-api/plugins
  npm install playwright-core
  ```

---

### 2. Download or Build Plugin Binary

#### Option A: Download Pre-built Release
Download the compiled binary for your operating system from the [Releases](https://github.com/commonriskpro/cpamc-gemini-argon/releases) page:
- **macOS (Apple Silicon)**: `cpamc-gemini-argon-darwin-arm64.dylib`
- **Linux (x86_64)**: `cpamc-gemini-argon-linux-amd64.so`
- **Linux (aarch64)**: `cpamc-gemini-argon-linux-arm64.so`

Place `gemini_runner.js` and the binary in `~/.cli-proxy-api/plugins/`.

#### Option B: Build From Source
```bash
git clone https://github.com/commonriskpro/cpamc-gemini-argon.git
cd cpamc-gemini-argon

# Build native library for current OS
make build

# Or cross-compile for Linux (requires zig cc)
make build-linux-amd64
make build-linux-arm64
```

---

### 3. Configure CPAMC

In your `~/.cli-proxy-api/config.yaml`:

```yaml
plugins:
  enabled: true
  dir: "/home/user/.cli-proxy-api/plugins"  # Adjust path to your host
  configs:
    gemini-argon:
      enabled: true
```

---

### 4. Add Google Session Credentials

1. Open **[gemini.google.com](https://gemini.google.com/app)** in your browser and ensure Gemini 4 Argon is active.
2. Export your session cookies (specifically `__Secure-1PSID`, `__Secure-1PSIDTS`, `SID`, `HSID`, `SSID`) as JSON or cookie string using a cookie extension (e.g. Cookie-Editor).
3. Save the credential into `~/.cli-proxy-api/auths/gemini-argon-1.json`:

```json
{
  "web_provider": "gemini",
  "cookie": "__Secure-1PSID=...; __Secure-1PSIDTS=...; SID=...; HSID=..."
}
```

You can add multiple files (`gemini-argon-1.json`, `gemini-argon-2.json`) for automatic multi-account load balancing.

---

### 5. Use in Codex

Add the model to your `~/.codex/models.json`:

```json
{
  "slug": "gemini-4-argon",
  "display_name": "Gemini 4 Argon (Web)",
  "description": "Gemini 4 Argon with Autonomous Tool Calling via CPAMC.",
  "default_reasoning_level": "high",
  "supported_in_api": true
}
```

Select **Gemini 4 Argon** in Codex and prompt away!

---

## License

MIT License (c) 2026 commonriskpro
