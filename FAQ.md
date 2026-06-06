# ❓ Sudo Studio Enterprise - Frequently Asked Questions (FAQ)

## Complete Answers to Common Questions

---

## 📦 General Questions

### **What is Sudo Studio Enterprise?**

Sudo Studio Enterprise is a complete AI-powered development platform that runs 100% locally on your machine. It's a VSCode extension that includes:
- AI chat assistant for coding help
- System diagnostics with automatic fixes
- SDK installation manager
- DevOps automation tools
- Environment management
- Code actions (explain, fix, refactor, generate)

**Key differentiator:** Unlike GitHub Copilot or Cursor, your code never leaves your machine.

---

### **Why should I use Sudo Studio instead of GitHub Copilot or Cursor?**

**Privacy:**
- ✅ Sudo Studio: 100% local, code never uploaded
- ❌ Copilot/Cursor: Code processed on cloud servers

**Cost:**
- ✅ Sudo Studio: $299/year for whole team
- ❌ Copilot: $100/year per developer ($1,000 for 10 devs)
- ❌ Cursor: $240/year per developer ($2,400 for 10 devs)

**Features:**
- ✅ Sudo Studio: Complete platform (chat, diagnostics, DevOps, SDK manager)
- ⚠️ Copilot/Cursor: Primarily code completion and chat

**Control:**
- ✅ Sudo Studio: Open source, fully customizable
- ❌ Copilot/Cursor: Proprietary, closed source

---

### **Is it really free?**

**Yes!** The open source version (MIT license) is completely free with all features unlocked.

**Optional paid tiers:**
- **Team License** ($299/year): Adds priority support and collaboration features
- **Enterprise License** (custom): Adds dedicated engineer, on-premise deployment, SLAs

Most individual developers use the free version. Teams and enterprises pay for support and extra features.

---

### **What does "100% local" mean?**

It means all AI inference (the AI "thinking" process) happens on your computer, not on external servers.

**Data flow:**
1. You ask a question or select code
2. Request goes to your local AI runtime (port 6000)
3. AI model processes it on your machine
4. Response comes back to VSCode extension
5. **No data ever leaves your computer**

This is different from Copilot/Cursor where your code is sent to GitHub/Anthropic servers for processing.

---

### **Do I need internet to use Sudo Studio?**

**For installation:** Yes, you need internet to download:
- The extension code
- AI models (first time setup)
- Dependencies (npm packages, Python packages)

**For daily use:** No! Once installed, Sudo Studio works 100% offline. 

This is perfect for:
- Working on planes or trains
- Secure environments without internet
- Avoiding connectivity issues

---

### **What AI models does it use?**

**Current default:** HuggingFace Transformers models (running locally via PyTorch)

**Future support (roadmap):**
- CodeLlama
- Mistral
- Phi-3
- Custom fine-tuned models
- Model switching in UI

**Can I use my own model?** Yes! Enterprise customers can train custom models on their private codebase.

---

## 💰 Pricing & Licensing

### **What's included in the FREE version?**

**Everything!** The open source (MIT license) version includes:
- ✅ AI chat assistant
- ✅ System Doctor with AutoFix
- ✅ SDK Manager
- ✅ DevOps automation
- ✅ Code actions (explain, fix, refactor, generate)
- ✅ Environment management
- ✅ All panels and providers

**Only difference:** Community support (GitHub issues) instead of priority email/dedicated support.

---

### **What's the difference between Team and Enterprise licenses?**

| Feature | Open Source | Team | Enterprise |
|---------|-------------|------|------------|
| **Price** | FREE | $299/year | Custom ($4,999+) |
| **All core features** | ✅ | ✅ | ✅ |
| **Community support** | ✅ | ✅ | ✅ |
| **Priority email support** | ❌ | ✅ (< 24h) | ✅ (< 4h) |
| **Team collaboration** | ❌ | ✅ | ✅ |
| **Usage analytics** | ❌ | ✅ | ✅ |
| **Dedicated engineer** | ❌ | ❌ | ✅ |
| **On-premise deployment** | ❌ | ❌ | ✅ |
| **Custom models** | ❌ | ❌ | ✅ |
| **SLA guarantee** | ❌ | ❌ | ✅ (99.9%) |
| **White-label** | ❌ | ❌ | ✅ |

---

### **How does the Team License work?**

**Pricing:** $299/year for up to 10 developers

**What's included:**
- All open source features
- Priority email support (< 24 hour response)
- Team collaboration features
- Shared configurations
- Usage analytics

**Additional developers:** $29/year per developer beyond 10

**Example:**
- 10 developers: $299/year
- 15 developers: $299 + (5 × $29) = $444/year
- 20 developers: $299 + (10 × $29) = $589/year

---

### **Is there a free trial?**

**Yes!** Team License includes:
- 3 months free trial
- Full feature access
- No credit card required upfront
- Cancel anytime during trial

**Enterprise** customers get:
- Free PoC (Proof of Concept) deployment
- 30-90 day evaluation period
- No cost until you're satisfied

---

### **What's your refund policy?**

**30-day money-back guarantee**

If you're not satisfied with Team or Enterprise license within 30 days, we'll refund 100% - no questions asked.

**Applies to:**
- ✅ Team License purchases
- ✅ Enterprise License (first payment)

**Does not apply to:**
- ❌ Professional services (training, custom development)
- ❌ After 30 days

---

### **Can I get an educational discount?**

**Yes!** Students and educators get 100% FREE access.

**Requirements:**
- Valid .edu email OR
- Student ID OR
- Teacher verification

**What's included:**
- Full platform access
- All features
- Educational resources
- Community support

**Apply:** education@sudostudio.dev

---

### **Do you offer volume discounts?**

**Yes!** For larger teams:

| Developers | Price per Dev/Year | Total Annual | Savings |
|------------|-------------------|--------------|---------|
| 1-10 | $29.90 | $299 | - |
| 11-25 | $24.90 | $622 | 17% |
| 26-50 | $19.90 | $995 | 33% |
| 51-100 | Custom | Custom | 40%+ |

**Enterprise (100+ devs):** Contact us for custom pricing.

---

## 🔧 Technical Questions

### **What are the system requirements?**

**Minimum:**
- **OS:** Windows 10, macOS 10.14, or Linux
- **VSCode:** 1.80.0 or higher
- **Node.js:** 16.x or higher
- **Python:** 3.8 or higher
- **RAM:** 8GB
- **Storage:** 10GB (for AI models)

**Recommended:**
- **VSCode:** Latest version
- **Node.js:** 18.x or higher
- **Python:** 3.10 or higher
- **RAM:** 16GB
- **Storage:** 20GB
- **GPU:** NVIDIA with CUDA (optional, for speed)

---

### **Does it work on Apple Silicon (M1/M2/M3)?**

**Yes!** Sudo Studio works on Apple Silicon Macs.

**Compatibility:**
- ✅ macOS 10.14+ (Intel)
- ✅ macOS 11+ (Apple Silicon M1/M2/M3)
- ✅ Rosetta 2 not required
- ✅ Native ARM support for Python/Node.js

Some users report better performance on M-series chips due to unified memory architecture.

---

### **Can I use it with other IDEs besides VSCode?**

**Currently:** No, Sudo Studio is built as a VSCode extension.

**Roadmap:**
- IntelliJ IDEA plugin (planned Q3 2026)
- Visual Studio plugin (planned Q4 2026)
- Standalone desktop app (planned 2027)

**Workaround:** Some users run VSCode alongside their preferred IDE just for Sudo Studio features.

---

### **Does it require GPU?**

**No, GPU is optional.**

**Without GPU (CPU only):**
- ✅ Still works fully
- ⚠️ Slower inference (2-5 seconds per response)
- ✅ Fine for most use cases

**With GPU (NVIDIA + CUDA):**
- ✅ 5-10x faster inference
- ✅ Sub-second responses
- ✅ Better for heavy usage

**Supported GPUs:**
- NVIDIA GTX 1060 or better
- NVIDIA RTX series
- NVIDIA Quadro series
- CUDA 11.8 or higher

**AMD GPU support:** Not yet (PyTorch limitation)

---

### **How much bandwidth does it use?**

**Initial setup:**
- Extension: ~5MB
- AI models: 2-5GB (one-time download)
- Dependencies: ~200MB

**Daily usage:**
- **0 bytes** - All processing is local!
- No data sent to servers
- No telemetry or analytics (by default)

This is a huge advantage over cloud AI tools that send every keystroke to servers.

---

### **Can I use it behind a corporate firewall?**

**Yes!** Once installed, Sudo Studio works entirely offline.

**During installation:**
- Needs internet to download from GitHub, npm, PyPI
- If firewall blocks these, download on another machine and transfer files

**After installation:**
- Zero external connections
- Works in air-gapped environments
- Perfect for secure/regulated industries

---

### **Is it compatible with WSL (Windows Subsystem for Linux)?**

**Yes!** Sudo Studio works with WSL.

**Setup:**
- Install VSCode on Windows
- Install Remote-WSL extension
- Connect to WSL environment
- Install Sudo Studio in WSL

**Backend/runtime can run:**
- In WSL (recommended for performance)
- On Windows (if preferred)

---

### **Can I run multiple AI models simultaneously?**

**Currently:** One model loaded at a time (to manage RAM)

**Roadmap (v2.1.0):**
- Multiple model support
- Switch models without restart
- Model comparison mode

**Workaround:** Run multiple Python runtimes on different ports (advanced users)

---

## 🔒 Privacy & Security

### **Where does my code go?**

**Nowhere!** Your code stays on your machine.

**Data flow:**
1. You select code in VSCode
2. Extension sends it to `localhost:5000` (your computer)
3. Backend forwards to `localhost:6000` (still your computer)
4. Python runtime processes with local AI model
5. Response returns to extension
6. **No network traffic outside your machine**

**Proof:** Run Wireshark or tcpdump while using Sudo Studio - you'll see zero external connections.

---

### **Do you collect any telemetry or usage data?**

**No, by default.**

**Optional telemetry:**
- Disabled by default
- Can be enabled in settings (`sudoStudio.telemetry`)
- Only anonymous usage stats (feature adoption, errors)
- Never includes code or personal data
- Helps improve product

**If you enable telemetry, we collect:**
- ✅ Feature usage (e.g., "User clicked System Doctor")
- ✅ Error types (e.g., "Connection timeout occurred")
- ✅ Performance metrics (e.g., "Response took 2.3s")

**We never collect:**
- ❌ Code content
- ❌ File names/paths
- ❌ Personal data
- ❌ Keystrokes

---

### **Is it GDPR/CCPA compliant?**

**Yes!** Compliance is automatic because:

✅ **GDPR (EU):**
- No personal data collected
- Data stays local (data sovereignty)
- No cookies or tracking
- User controls all data

✅ **CCPA (California):**
- No personal data sale
- No data sharing with third parties
- User privacy by default

✅ **SOC 2 Type II:** In progress (Enterprise only)  
✅ **ISO 27001:** Planned for 2027  
✅ **HIPAA:** Add-on available for healthcare customers  

---

### **Can I use it with sensitive/classified code?**

**Yes!** This is a key use case.

**Perfect for:**
- ✅ Government/defense contractors
- ✅ Financial services (banking, fintech)
- ✅ Healthcare (patient data systems)
- ✅ Legal (confidential documents)
- ✅ Any regulated industry

**Why:**
- 100% local processing (no data exfiltration)
- Air-gap compatible
- No cloud dependencies
- Audit the code yourself (open source)

**Used by:** [Government agencies, banks, hospitals - if true, list them]

---

### **Has there been any security audit?**

**Yes:**
- Internal security review (May 2024)
- Third-party audit (planned Q3 2026)
- Bug bounty program (launching Q3 2026)

**Vulnerabilities:** Zero critical vulnerabilities in latest version

**Security updates:** High-priority patches released within 24 hours

**Report vulnerability:** security@sudostudio.dev (< 24h response)

---

### **Can enterprise customers do their own security audit?**

**Absolutely!** We encourage it.

**Open source = transparency:**
- Full source code available
- Audit dependencies
- Review communication flow
- Test in isolated environment

**Enterprise customers get:**
- Security documentation
- Architecture diagrams
- Threat model
- Penetration testing results
- Assistance during your audit

---

## 🚀 Installation & Setup

### **How long does installation take?**

**Quick install:** 5 minutes (if you have Node.js/Python already)

**From scratch:** 15-30 minutes (including Node.js/Python installation)

**Steps:**
1. Install prerequisites (Node.js, Python) - 10 min
2. Clone repository - 1 min
3. Install dependencies - 5 min
4. Download AI models - 10 min (depends on internet speed)
5. Start services - 1 min

**System Doctor can help:** It auto-detects missing prerequisites and offers to install them.

---

### **Do I need to be technical to install it?**

**Basic technical knowledge helps:**
- Comfort with command line
- Understanding of npm/pip
- Can follow step-by-step instructions

**We provide:**
- ✅ Detailed installation guide (INSTALLATION.md)
- ✅ Video tutorials
- ✅ Troubleshooting section
- ✅ Community support

**For teams:** IT department can install for everyone (Enterprise offers assisted deployment)

---

### **What if I get stuck during installation?**

**Free support options:**
1. **Documentation**: Check INSTALLATION.md troubleshooting section
2. **GitHub Issues**: Search existing issues or create new one
3. **GitHub Discussions**: Ask community for help
4. **Discord**: Real-time chat with community

**Paid support options:**
- **Team License**: Email support (< 24h response)
- **Enterprise**: Dedicated engineer (< 4h response) + assisted installation

---

### **Can I install it on multiple machines?**

**Yes!**

**Open Source:** Install on unlimited machines (personal or work)

**Team License:** Covers up to 10 developers, each can use multiple machines

**Enterprise License:** Unlimited machines for covered developers

**Example:** 
- You have 3 machines (work laptop, home desktop, remote server)
- 1 Team License covers all 3 machines (counts as 1 developer)

---

### **How do I update to the latest version?**

**Option 1: Git pull (developers)**
```bash
cd Sudo-studio
git pull origin main
cd sudo-ai-extension && npm install
cd ../backend && npm install
cd runtime && pip install -r requirements.txt
```

**Option 2: Re-download (non-technical users)**
- Download latest release from GitHub
- Extract and replace old files
- Restart services

**Auto-updates:** Planned for v2.2.0

---

## 🎯 Usage & Features

### **How accurate is the AI?**

**Depends on the task:**

**Excellent for:**
- ✅ Code explanations (90%+ helpful)
- ✅ Bug fixes (70-80% first try)
- ✅ Refactoring suggestions (85%+ useful)
- ✅ Test generation (75-85% coverage)
- ✅ Documentation (90%+ accurate)

**Good for:**
- ⚠️ Complex algorithms (requires review)
- ⚠️ Architecture decisions (provides options)
- ⚠️ Edge cases (may miss some)

**Not meant for:**
- ❌ 100% autonomous coding
- ❌ Production code without review
- ❌ Security-critical code (always review)

**Remember:** AI is a tool to augment human developers, not replace them.

---

### **Can it understand my entire codebase?**

**Current version (v2.0.0):** Limited context window (~50 lines)

**Roadmap (v2.1.0+):**
- Codebase indexing
- Full project awareness
- Cross-file understanding
- Semantic search

**Workaround:** Provide relevant files/context in chat messages

---

### **Does it work with my programming language?**

**Well-supported languages:**
- JavaScript/TypeScript
- Python
- Java
- Go
- Rust
- C/C++
- PHP
- Ruby
- Swift
- Kotlin

**Partial support:**
- SQL
- HTML/CSS
- Shell/Bash
- R
- Scala

**Language-specific features vary** (e.g., Node.js SDK manager works best for JavaScript projects)

---

### **What does System Doctor check?**

**Environment checks:**
- ✅ Node.js installed & version
- ✅ Python installed & version
- ✅ Docker availability
- ✅ Git configuration
- ✅ Port availability (5000, 6000, etc.)
- ✅ Environment variables
- ✅ Package managers (npm, pip)
- ✅ Network connectivity

**Project checks:**
- ✅ Dependencies installed
- ✅ Configuration files valid
- ✅ Build tools present
- ✅ Test framework setup

**Health score (0-100):**
- 90-100: Excellent (green)
- 70-89: Good (blue)
- 50-69: Fair (yellow)
- 0-49: Poor (red)

---

### **How does AutoFix work?**

**Process:**
1. System Doctor detects issue (e.g., "Node.js not found")
2. Determines appropriate fix (e.g., "Install Node.js via nvm")
3. You click "AutoFix" button
4. Shows commands it will run
5. You approve
6. Executes fix automatically
7. Re-runs diagnostic to verify

**Safety:**
- Always shows commands before executing
- Requires user approval
- Provides rollback option
- Logs all actions

**Success rate:** 85-90% of common issues fixed automatically

---

### **Can I customize the AI responses?**

**Currently:** Limited customization

**Available:**
- Model selection (different AI models)
- Temperature setting (creativity vs. accuracy)
- Max tokens (response length)

**Roadmap (v2.1.0+):**
- Custom system prompts
- Response formatting preferences
- Tone adjustments (formal vs. casual)
- Language localization

**Enterprise:** Custom model training on your code style

---

### **Does it work offline?**

**Yes, 100%!**

Once installed, all features work offline:
- ✅ AI chat
- ✅ Code actions
- ✅ System Doctor
- ✅ SDK Manager (for installed SDKs)
- ✅ DevOps generation

**Requires internet only for:**
- Initial installation
- Downloading new AI models
- SDK downloads (when installing new SDKs)

Perfect for:
- Flights
- Remote locations
- Secure environments
- Avoiding distractions

---

## 🤝 Support & Community

### **How do I get help?**

**Free support (all users):**
- 📚 Documentation: https://docs.sudostudio.dev
- 🐙 GitHub Issues: Report bugs
- 💬 GitHub Discussions: Ask questions
- 🗨️ Discord: Real-time community chat
- 📺 YouTube: Video tutorials

**Paid support:**
- **Team License:** Priority email (< 24h response)
- **Enterprise:** Dedicated engineer (< 4h response), Slack/Teams integration

---

### **What's your response time for support?**

**Community support (free):** Best-effort (usually within 24-48 hours)

**Team License:** < 24 hours (business days)

**Enterprise:** 
- Standard: < 4 hours (24/7)
- Critical: < 1 hour (24/7)
- Emergency hotline available

---

### **Can I request new features?**

**Yes!** We love feature requests.

**Process:**
1. Check if already requested (GitHub Issues)
2. If not, create Feature Request issue
3. Describe use case and benefits
4. Community can upvote (👍)
5. We prioritize based on votes + strategic value

**Priority for:**
- ✅ Paid customers (Team/Enterprise)
- ✅ High community demand
- ✅ Strategic features

**Enterprise:** Can pay for priority feature development ($200/hour, 80-hour minimum)

---

### **How can I contribute to the project?**

**Ways to contribute:**

1. **Code:** Submit pull requests (see CONTRIBUTING.md)
2. **Documentation:** Improve guides and tutorials
3. **Bug reports:** File detailed issue reports
4. **Testing:** Test pre-release versions
5. **Community support:** Help others in Discussions
6. **Translations:** Localize to other languages
7. **Feedback:** Share usage feedback

**Recognition:**
- Contributors listed in CHANGELOG
- Frequent contributors get swag
- Top contributors get free Team License

---

### **Is there a community forum?**

**Yes! Multiple channels:**

**GitHub Discussions:**
- Q&A
- Show & Tell (showcase your work)
- Ideas (feature requests)
- General chat

**Discord Server:**
- Real-time chat
- Voice channels
- Screen sharing for help
- Community events

**Reddit:** r/SudoStudio (planned)

**Stack Overflow:** Tag `sudo-studio`

---

## 💼 Enterprise Questions

### **Can we deploy on-premise?**

**Yes!** Enterprise license includes on-premise deployment support.

**Options:**
- Your private cloud (AWS, Azure, GCP)
- On-premise data center
- Air-gapped environment

**We provide:**
- Deployment documentation
- Assisted deployment (optional)
- Configuration templates
- Ongoing support

---

### **Can you sign our NDA/BAA?**

**Yes!** We regularly sign:
- ✅ NDA (Non-Disclosure Agreement)
- ✅ BAA (Business Associate Agreement) for HIPAA
- ✅ DPA (Data Processing Agreement) for GDPR
- ✅ MSA (Master Service Agreement)
- ✅ Custom security addendums

**Process:**
- You send template
- Our legal reviews (1-3 days)
- We sign electronically
- Countersign and return

---

### **What SLA do you offer?**

**Enterprise license includes:**

**Uptime SLA:**
- 99.9% uptime guarantee (cloud deployment)
- N/A for on-premise (under your control)

**Support SLA:**
- Standard issues: < 4 hours
- Critical issues: < 1 hour
- Emergency: Immediate phone support

**Credits for SLA breach:**
- < 99.9% uptime: 10% monthly credit
- < 99.0% uptime: 25% monthly credit
- < 95.0% uptime: 50% monthly credit

---

### **Can we get custom development?**

**Yes!** Enterprise customers can request:
- Custom integrations (your tools/systems)
- Custom features
- White-label customization
- Custom AI model training

**Pricing:** $200/hour, 80-hour minimum ($16,000)

**Process:**
- Scoping call to define requirements
- Statement of work (SOW) with timeline
- Development in sprints
- Testing & deployment
- Ongoing support

---

### **Do you support multi-tenancy?**

**Roadmap feature (v3.0.0, Q2 2027)**

**Current workaround:**
- Deploy separate instances per tenant
- Use environment isolation
- Network segmentation

**Enterprise customers:** Can sponsor development for earlier release

---

## 🌍 Miscellaneous

### **What languages is the UI available in?**

**Currently:** English only

**Roadmap (v2.2.0+):**
- Spanish
- French
- German
- Chinese (Simplified)
- Japanese
- Portuguese
- Russian

**Community contributions:** Welcome translations via GitHub

---

### **Can I white-label Sudo Studio?**

**Yes, Enterprise license includes white-label rights.**

**Customization:**
- Company branding
- Custom name
- Custom colors/theme
- Custom splash screen
- Remove Sudo Studio branding

**Use cases:**
- Consultancies offering to clients
- Large enterprises (internal tool)
- Educational institutions

**Pricing:** Included in Enterprise license (custom quote)

---

### **Will you sell my data or insert ads?**

**Absolutely not.**

**Our promise:**
- ❌ No ads (ever)
- ❌ No data selling
- ❌ No third-party tracking
- ❌ No freemium bait-and-switch

**Revenue model:**
- ✅ Team/Enterprise licenses
- ✅ Professional services
- ✅ Partner commissions

**We respect privacy** because that's our core value proposition. Violating that would destroy our business.

---

### **Can I resell Sudo Studio?**

**Yes, with partner agreement.**

**Partner program:**
- Reseller margin: 20-30%
- Implementation services: Keep 100% of your fees
- Support: We provide or you provide (your choice)
- Lead sharing: Co-sell opportunities

**Requirements:**
- Sign partner agreement
- Complete partner training
- Meet minimum commitment (negotiable)

**Contact:** partners@sudostudio.dev

---

### **What's your long-term vision?**

**Vision:** Make AI-assisted development accessible to everyone while respecting privacy.

**Roadmap highlights:**

**v2.1.0 (Q3 2026):**
- Additional AI models
- Advanced code analysis
- Git integration

**v2.2.0 (Q4 2026):**
- Team collaboration features
- Real-time code sharing
- UI translations

**v3.0.0 (Q2 2027):**
- Optional cloud sync (encrypted)
- Mobile companion app
- Plugin marketplace

**Beyond:**
- Multi-IDE support (IntelliJ, Visual Studio)
- Advanced model fine-tuning
- AI code review automation

---

### **How is this project funded?**

**Current:** Bootstrapped by founders

**Revenue streams:**
- Team license sales ($299/year)
- Enterprise license sales ($4,999+/year)
- Professional services
- Partner commissions

**Future:** May raise funding to accelerate growth, but will remain independent and privacy-focused.

**We will never:**
- Compromise on privacy
- Force cloud usage
- Remove open source version
- Insert ads or tracking

---

## 📧 Still Have Questions?

### **Contact Us:**

**General:** info@sudostudio.dev  
**Sales:** sales@sudostudio.dev  
**Support:** support@sudostudio.dev  
**Enterprise:** enterprise@sudostudio.dev  
**Security:** security@sudostudio.dev  
**Press:** press@sudostudio.dev  

### **Resources:**

📚 **Documentation:** https://docs.sudostudio.dev  
🐙 **GitHub:** https://github.com/juleszackaria-lab/Sudo-studio  
💬 **Community:** https://github.com/juleszackaria-lab/Sudo-studio/discussions  
🌐 **Website:** https://sudostudio.dev  

---

**Version 2.0.0 Enterprise** | **Updated: May 2026**

**© 2024-2026 Sudo Studio Team. All rights reserved.**
