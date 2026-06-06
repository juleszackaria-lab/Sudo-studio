# 🤝 Contributing to Sudo Studio Enterprise

Thank you for your interest in contributing to Sudo Studio! We welcome contributions from the community.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Pull Request Process](#pull-request-process)
- [Bug Reports](#bug-reports)
- [Feature Requests](#feature-requests)
- [Community](#community)

---

## 📜 Code of Conduct

### Our Pledge

We are committed to providing a welcoming and inspiring community for all.

### Our Standards

**Positive behavior includes:**
- ✅ Being respectful and inclusive
- ✅ Welcoming newcomers
- ✅ Accepting constructive criticism
- ✅ Focusing on what's best for the community
- ✅ Showing empathy

**Unacceptable behavior includes:**
- ❌ Harassment or discriminatory language
- ❌ Trolling or insulting comments
- ❌ Personal or political attacks
- ❌ Publishing others' private information
- ❌ Any conduct that could be considered inappropriate

### Enforcement

Violations may result in temporary or permanent ban from the project.

Report issues to: conduct@sudostudio.dev

---

## 🎯 How Can I Contribute?

### 1. Report Bugs
Found a bug? [Open an issue](https://github.com/juleszackaria-lab/Sudo-studio/issues/new?template=bug_report.md)

### 2. Suggest Features
Have an idea? [Open a feature request](https://github.com/juleszackaria-lab/Sudo-studio/issues/new?template=feature_request.md)

### 3. Improve Documentation
- Fix typos
- Add examples
- Improve clarity
- Translate docs

### 4. Write Code
- Fix bugs
- Implement features
- Improve performance
- Add tests

### 5. Help Others
- Answer questions in discussions
- Review pull requests
- Help with testing

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js** 16.x or higher
- **Python** 3.8 or higher
- **Git**
- **VSCode** (for extension development)

### Clone Repository

```bash
git clone https://github.com/juleszackaria-lab/Sudo-studio.git
cd Sudo-studio
```

### Install Dependencies

**Backend:**
```bash
cd backend
npm install
```

**Extension:**
```bash
cd sudo-ai-extension
npm install
```

**Python Runtime:**
```bash
cd backend/runtime
pip install -r requirements.txt
```

### Run Development Environment

**Terminal 1 - Backend:**
```bash
cd backend
npm run dev  # or: node server.js
```

**Terminal 2 - Python Runtime:**
```bash
cd backend/runtime
python server.enterprise.py
```

**Terminal 3 - Extension:**
```bash
cd sudo-ai-extension
code .
# Press F5 to launch Extension Development Host
```

### Run Tests

**Backend Tests:**
```bash
cd backend
npm test
```

**Extension Tests:**
```bash
cd sudo-ai-extension
npm test
```

**Complete Test Suite:**
```bash
node test-extension-complete.js
```

---

## 📝 Coding Standards

### JavaScript/Node.js

**Style Guide:**
- Use ES6+ features
- 4 spaces for indentation
- Single quotes for strings
- Semicolons required
- Descriptive variable names

**Example:**
```javascript
// Good
const getUserData = async (userId) => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
};

// Bad
const getData=async(id)=>{const r=await fetch("/api/users/"+id);return r.json()}
```

**ESLint:**
```bash
npm run lint
```

### Python

**Style Guide:**
- Follow PEP 8
- 4 spaces for indentation
- Type hints where applicable
- Docstrings for functions/classes

**Example:**
```python
# Good
def process_user_data(user_id: int) -> dict:
    """
    Process user data and return formatted result.
    
    Args:
        user_id: The user's ID
        
    Returns:
        Dict containing processed user data
    """
    data = fetch_user(user_id)
    return format_data(data)

# Bad
def process(id):
    d=fetch(id)
    return format(d)
```

**Linting:**
```bash
pylint backend/runtime/*.py
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Maintenance

**Examples:**
```
feat(chat): add markdown rendering support

- Integrated marked.js library
- Added syntax highlighting for code blocks
- Updated chat panel UI

Closes #123
```

```
fix(doctor): resolve AutoFix button crash

Fixed issue where AutoFix would crash when issue type was undefined.

Fixes #456
```

---

## 🔄 Pull Request Process

### Before Submitting

1. **Create Issue First** (unless it's a trivial fix)
2. **Fork Repository**
3. **Create Feature Branch**: `git checkout -b feat/your-feature`
4. **Make Changes**
5. **Add Tests**
6. **Update Documentation**
7. **Run Linter**: `npm run lint`
8. **Run Tests**: `npm test`
9. **Commit Changes**: Use conventional commits

### Submitting PR

1. **Push Branch**: `git push origin feat/your-feature`
2. **Open PR** on GitHub
3. **Fill PR Template**:
   - Description of changes
   - Related issues
   - Testing performed
   - Screenshots (if UI changes)
4. **Wait for Review**

### PR Template

```markdown
## Description
Brief description of changes

## Related Issues
Closes #123

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Screenshots
(if applicable)

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added where needed
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] No new warnings
```

### Review Process

1. **Automated Checks**: CI/CD runs tests
2. **Code Review**: Maintainers review code
3. **Feedback**: Address review comments
4. **Approval**: Get approval from maintainer
5. **Merge**: Maintainer merges PR

### After Merge

- Your contribution is included in next release
- You're added to contributors list
- Thank you! 🎉

---

## 🐛 Bug Reports

### Before Reporting

1. **Check Existing Issues**: Search for similar issues
2. **Update to Latest**: Ensure you're on latest version
3. **Reproduce**: Can you consistently reproduce the bug?

### Bug Report Template

```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots.

**Environment:**
- OS: [e.g., Windows 11]
- VSCode: [e.g., 1.85.0]
- Extension: [e.g., 2.0.0]
- Node: [e.g., 18.0.0]
- Python: [e.g., 3.10]

**Additional context**
Any other relevant information.

**Logs**
```
Paste relevant logs here
```
```

**[Report Bug](https://github.com/juleszackaria-lab/Sudo-studio/issues/new?template=bug_report.md)**

---

## 💡 Feature Requests

### Before Requesting

1. **Check Roadmap**: Is it already planned?
2. **Search Issues**: Has someone else requested it?
3. **Consider Scope**: Is it within project scope?

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of the problem.

**Describe the solution you'd like**
What you want to happen.

**Describe alternatives you've considered**
Other solutions you've thought about.

**Use Cases**
How would this feature be used?

**Additional context**
Any other relevant information.

**Mockups**
(if applicable)
```

**[Request Feature](https://github.com/juleszackaria-lab/Sudo-studio/issues/new?template=feature_request.md)**

---

## 🏗️ Project Structure

```
Sudo-studio/
├── backend/                  # Express.js backend
│   ├── routes/              # API routes
│   ├── middleware/          # Express middleware
│   ├── runtime/             # Python AI runtime
│   └── server.js           # Main server file
│
├── sudo-ai-extension/       # VSCode extension
│   ├── extension.js        # Extension entry point
│   ├── package.json        # Extension manifest
│   └── src/
│       ├── services/       # Backend services
│       ├── providers/      # Tree view providers
│       └── panels/         # Webview panels
│
├── docs/                    # Documentation
├── test/                    # Test files
└── README.md               # Main readme
```

---

## 🧪 Testing Guidelines

### Unit Tests

- Test individual functions/methods
- Mock external dependencies
- Cover edge cases
- Aim for 80%+ coverage

**Example:**
```javascript
describe('BackendService', () => {
    it('should send chat message', async () => {
        const service = new BackendService();
        const response = await service.sendChatMessage('test');
        expect(response).toHaveProperty('reply');
    });
});
```

### Integration Tests

- Test component interactions
- Use real backend/runtime
- Test full workflows

### Manual Testing

- Test in real VSCode environment
- Check UI/UX
- Verify error handling
- Test edge cases

---

## 📚 Documentation Guidelines

### Code Documentation

**JavaScript:**
```javascript
/**
 * Sends a chat message to the AI backend.
 * 
 * @param {string} message - The user's message
 * @param {string} model - The AI model to use
 * @returns {Promise<Object>} The AI response
 * @throws {Error} If backend is unavailable
 */
async function sendChatMessage(message, model = 'default') {
    // Implementation
}
```

**Python:**
```python
def process_inference(prompt: str, max_tokens: int = 512) -> str:
    """
    Process AI inference with the given prompt.
    
    Args:
        prompt: The input prompt for the model
        max_tokens: Maximum tokens to generate
        
    Returns:
        The generated text response
        
    Raises:
        ModelNotLoadedError: If model is not loaded
    """
    # Implementation
```

### User Documentation

- Write clearly and concisely
- Include examples
- Add screenshots
- Link related topics

---

## 🌍 Community

### Communication Channels

- **GitHub Discussions**: [Ask questions, share ideas](https://github.com/juleszackaria-lab/Sudo-studio/discussions)
- **GitHub Issues**: [Report bugs, request features](https://github.com/juleszackaria-lab/Sudo-studio/issues)
- **Discord**: [Join our community](https://discord.gg/sudostudio) (coming soon)
- **Twitter**: [@SudoStudioDev](https://twitter.com/SudoStudioDev)

### Getting Help

1. **Documentation**: Check [docs.sudostudio.dev](https://docs.sudostudio.dev)
2. **Search Issues**: Someone may have asked before
3. **Ask Question**: Post in GitHub Discussions
4. **Join Discord**: Chat with community (coming soon)

### Recognition

Contributors are recognized in:
- **README.md**: Contributors section
- **CHANGELOG.md**: Release notes
- **Website**: Contributors page (coming soon)

---

## 📅 Release Process

### Versioning

We use [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0): Breaking changes
- **Minor** (1.1.0): New features, backwards compatible
- **Patch** (1.1.1): Bug fixes

### Release Schedule

- **Major**: Every 6-12 months
- **Minor**: Every 1-2 months
- **Patch**: As needed for critical bugs

### Changelog

All changes documented in [CHANGELOG.md](CHANGELOG.md)

---

## 🎓 Learning Resources

### For New Contributors

- [First Contributions](https://github.com/firstcontributions/first-contributions)
- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [VSCode Extension API](https://code.visualstudio.com/api)

### Project-Specific

- [Architecture Documentation](ARCHITECTURE.md)
- [API Documentation](docs/API.md)
- [Development Guide](docs/DEVELOPMENT.md)

---

## 🙏 Thank You

Thank you for contributing to Sudo Studio! Every contribution, no matter how small, helps make this project better.

**Top Contributors:**
- (Your name could be here!)

---

## 📧 Contact

**Maintainers:**
- Lead Developer: dev@sudostudio.dev
- Community Manager: community@sudostudio.dev

**General:** contact@sudostudio.dev

---

**Last Updated:** May 2026

**Version:** 2.0.0 Enterprise
