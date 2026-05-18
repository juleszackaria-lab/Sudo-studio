# Sudo AI Extension

AI-powered coding assistant for VSCodium with multi-model support (Ollama, vLLM, DeepSeek, etc.)

## 🚀 Features

- **Multi-Model Support**: Choose from Llama 3, Mistral, Mixtral, Gemma, CodeLlama, Qwen Coder, DeepSeek Coder, and more
- **Local AI**: 100% local inference - no data sent to external servers
- **Code Actions**: 
  - Explain code
  - Fix and improve code
  - Generate code from descriptions
  - Refactor existing code
- **Interactive Chat**: Full conversational interface with AI
- **Context-Aware**: Automatically includes relevant code context
- **Fast**: Direct connection to local AI models via Sudo Studio backend

## 📋 Requirements

1. **Sudo Studio Backend** running on `http://localhost:5000`
2. **AI Models**: At least one of the following:
   - [Ollama](https://ollama.ai/) running on port 11434
   - vLLM/DeepSeek running on port 8000

## 🔧 Installation

### Method 1: From VSIX (Recommended)
```bash
# In the sudo-ai-extension directory
npm install
vsce package
code --install-extension sudo-ai-1.0.0.vsix
```

### Method 2: Development Mode
```bash
# Open VSCodium
# Press F5 to launch extension in development mode
```

## ⚙️ Configuration

Open Settings (`Ctrl+,`) and search for "Sudo AI":

```json
{
  "sudoAi.backendUrl": "http://localhost:5000",
  "sudoAi.defaultModel": "llama3",
  "sudoAi.autoComplete": false,
  "sudoAi.streamResponses": false,
  "sudoAi.contextLines": 50
}
```

### Available Models

| Model | Type | Best For |
|-------|------|----------|
| llama3 | General | Chat, questions |
| llama3.1 | General | Advanced reasoning |
| mistral | General | Fast responses |
| mixtral | General | Complex tasks |
| gemma4 | General | Balanced performance |
| codellama | Code | Code generation |
| qwen-coder | Code | Code analysis |
| qwen2.5-coder | Code | Latest code model |
| deepseek-coder | Code | Deep code understanding |
| deepseek-coder-v2 | Code | Advanced coding |

## 📖 Usage

### Commands

Press `Ctrl+Shift+P` and type "Sudo AI" to see all commands:

- **Sudo AI: Explain Code** - Select code and get explanation
- **Sudo AI: Fix Code** - Select buggy code to get fixes
- **Sudo AI: Generate Code** - Describe what you want to create
- **Sudo AI: Refactor Code** - Improve selected code quality
- **Sudo AI: Ask Question** - General questions about coding
- **Sudo AI: Open Chat** - Open interactive chat panel
- **Sudo AI: Select Model** - Choose which AI model to use

### Keyboard Shortcuts

You can set custom shortcuts in VSCodium keybindings:

```json
{
  { "key": "ctrl+alt+e", "command": "sudo-ai.explainCode" },
  { "key": "ctrl+alt+f", "command": "sudo-ai.fixCode" },
  { "key": "ctrl+alt+g", "command": "sudo-ai.generateCode" },
  { "key": "ctrl+alt+c", "command": "sudo-ai.openChat" }
}
```

### Context Menu

Right-click on selected code to access:
- Explain Code
- Fix Code
- Refactor Code

### Status Bar

Click the Sudo AI status bar item (bottom right) to quickly switch models.

## 🎯 Examples

### Explain Code
1. Select a function or code block
2. Right-click → "Sudo AI: Explain Code"
3. View explanation in side panel

### Fix Code
1. Select code with errors
2. Run "Sudo AI: Fix Code"
3. Get corrected version with explanation

### Generate Code
1. Run "Sudo AI: Generate Code"
2. Enter description: "Create a React login form with validation"
3. Get generated code

### Interactive Chat
1. Open chat panel
2. Ask questions like:
   - "How do I use async/await in JavaScript?"
   - "What's the difference between let and const?"
   - "Explain Redux in simple terms"

## 🔌 Architecture

```
VSCodium Extension (Frontend)
    ↓ HTTP POST
Sudo Studio Backend (:5000)
    ↓ HTTP POST
AI Model Services:
    - Ollama (:11434) → llama3, mistral, codellama, etc.
    - vLLM (:8000) → deepseek-coder, custom models
```

## 🐛 Troubleshooting

### "Cannot connect to backend"
- Ensure Sudo Studio backend is running: `cd backend && npm start`
- Check backend URL in settings

### "No AI models available"
- Start Ollama: `ollama serve`
- Pull models: `ollama pull llama3`
- Or start vLLM with your model

### "Model not responding"
- Check if model is loaded: Open http://localhost:11434/api/tags
- Try switching to a different model
- Check backend logs for errors

## 📦 API Endpoints Used

- `POST /api/ai/chat` - Main chat endpoint
- `GET /api/ai/models` - List available models
- `GET /api/ai/health` - Check AI services status
- `GET /api/system/status` - Backend health check

## 🛠️ Development

```bash
# Install dependencies
npm install

# Run in development
# Press F5 in VSCodium

# Build VSIX
npm install -g vsce
vsce package

# Lint
npm run lint
```

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## 🔗 Links

- [Sudo Studio](https://github.com/sudo-studio)
- [Ollama](https://ollama.ai/)
- [vLLM](https://github.com/vllm-project/vllm)

## 💡 Tips

1. **Choose the right model**: Use code-specific models (codellama, qwen-coder, deepseek-coder) for code tasks
2. **Provide context**: Select relevant code before asking questions
3. **Start small**: Test with simple prompts first
4. **Local is fast**: With good hardware, local models are often faster than API calls

---

Made with ❤️ by Sudo Studio Team
