# Sudo Studio

**A VSCode-based AI development assistant with local model support.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/juleszackaria-lab/Sudo-studio)

---

## What is Sudo Studio?

Sudo Studio is a VSCode extension that integrates a locally-running AI model into your development workflow. It runs **100% locally** — your code never leaves your machine.

Built on VSCodium (the open-source VSCode base), Sudo Studio adds AI-powered tooling directly to the editor.

---

## Features

### ✅ Working features

- **AI Chat** — Conversations with a local HuggingFace model (port 6000 runtime)
- **Autonomous Agent** — Writes files, runs commands, scaffolds apps from a single prompt
  - Supports: Flutter, React, Next.js, Express, FastAPI, Vue.js scaffolding
  - Hallucination guard: blocks irrelevant `git clone` calls
  - Path traversal protection for all file writes
- **System Doctor** — Detects installed SDKs and tools; launches install commands in a terminal
- **SDK Manager** — Lists common SDKs (Node, Python, Flutter, Docker, Java, Go, Rust, Android); installs via `winget`/`brew`/`apt`
- **DevOps Automation** — Generates Dockerfile, docker-compose, GitHub Actions, GitLab CI, Kubernetes manifests, nginx.conf from your project stack
- **Environment Profiles** — Snapshot, export, and compare dev environments across machines
- **Security Scanner** — Scans for hardcoded secrets and .gitignore gaps
- **License Panel** — Offline HMAC-SHA256 license validation
- **Duplication Manager** — Profile import/export with size guards
- **Central Management** — User/role/policy management UI

### 🚧 In progress / known limitations

- AI quality depends on the model you run locally (default: a small 1.5B model via the Python runtime). Larger models produce better tool calls.
- Silent Windows installation (via `winget`) requires Windows Package Manager to be present (Windows 10 1709+ with App Installer).
- The build pipeline produces a branded Sudo Studio executable from VSCodium — branding patching is automated but may need adjustment for new VSCodium versions.
- No marketplace distribution yet — install by building from source or using the GitHub Actions artifact.

---

## Requirements

- **Node.js** 18+ and npm
- **Python** 3.9+ (for the AI runtime)
- **VSCodium** or the build pipeline (see `.github/workflows/`)

---

## Quick Start

### Run the extension in development

```bash
# Install extension dependencies
cd sudo-ai-extension
npm install

# Start the AI runtime (separate terminal)
cd backend/runtime
pip install -r requirements.txt
python server.py   # starts on port 6000

# Open the extension in VSCode/VSCodium
# Press F5 to launch Extension Development Host
```

### Build a standalone installer (Windows)

The GitHub Actions workflow in `.github/workflows/03-package.yml` downloads VSCodium, patches branding, and packages a Windows installer.

```bash
# Trigger manually via GitHub Actions or run locally with act
```

---

## Project Structure

```
sudo-ai-extension/      VSCode extension (panels, agent, commands)
  src/
    agent/AgentEngine.js   Autonomous agent (v3.0)
    panels/                UI panels (Chat, Doctor, SDK, DevOps, ...)
backend/
  runtime/server.py        Python AI runtime (HuggingFace, port 6000)
  routes/                  Express API routes
scripts/
  customize-vscodium.ps1   Branding patch script
.github/workflows/         Build + package pipeline
```

---

## Architecture

```
User → VSCode Extension (Node.js)
         ↓ HTTP (localhost:6000)
       Python Runtime (HuggingFace Transformers)
         ↓
       Local AI Model (GGUF / HF format)
```

All communication stays on `localhost`. No telemetry, no cloud calls.

---

## Security

- All webview messages are validated before processing (type, length, format)
- No raw error messages exposed to users (no `e.message` in UI strings)
- Path traversal prevention on all file write operations
- Input sanitization on all panel handlers

See `SECURITY.md` for the full policy.

---

## License

MIT — see `LICENSE` file.

---

## Contributing

See `CONTRIBUTING.md`.
