const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth.middleware');

/**
 * SDK Routes
 * SDK detection and installation management
 */

/**
 * GET /api/sdk/list
 * List all supported SDKs and their detection status
 */
router.get('/api/sdk/list', verifyToken, (req, res) => {
  const sdks = [
    { id: 'nodejs', name: 'Node.js', command: 'node --version', category: 'runtime' },
    { id: 'python', name: 'Python 3', command: 'python3 --version || python --version', category: 'runtime' },
    { id: 'java', name: 'Java JDK', command: 'java --version', category: 'runtime' },
    { id: 'dotnet', name: '.NET SDK', command: 'dotnet --version', category: 'runtime' },
    { id: 'go', name: 'Go', command: 'go version', category: 'runtime' },
    { id: 'rust', name: 'Rust', command: 'rustc --version', category: 'runtime' },
    { id: 'ruby', name: 'Ruby', command: 'ruby --version', category: 'runtime' },
    { id: 'php', name: 'PHP', command: 'php --version', category: 'runtime' },
    { id: 'docker', name: 'Docker', command: 'docker --version', category: 'devops' },
    { id: 'git', name: 'Git', command: 'git --version', category: 'vcs' },
    { id: 'android', name: 'Android SDK', command: 'adb --version', category: 'mobile' }
  ];

  res.json({ total: sdks.length, sdks });
});

/**
 * POST /api/sdk/install
 * Install a specific SDK
 * 
 * Body: {
 *   sdk: string (sdk id),
 *   version: string (optional)
 * }
 */
router.post('/api/sdk/install', verifyToken, async (req, res) => {
  try {
    const { sdk: sdkRaw, version } = req.body;

    if (!sdkRaw) {
      return res.status(400).json({ error: 'sdk is required' });
    }

    // Normalize: accept both id ("nodejs") and display name ("Node.js", "Python 3", etc.)
    const nameToId = {
      'node.js': 'nodejs', 'node': 'nodejs', 'nodejs': 'nodejs',
      'python 3': 'python', 'python3': 'python', 'python': 'python',
      'java jdk': 'java', 'java': 'java',
      '.net sdk': 'dotnet', '.net': 'dotnet', 'dotnet': 'dotnet',
      'go': 'go',
      'rust': 'rust',
      'ruby': 'ruby',
      'php': 'php',
      'docker': 'docker',
      'git': 'git',
      'android sdk': 'android', 'android': 'android'
    };
    const sdk = nameToId[sdkRaw.toLowerCase()] || sdkRaw.toLowerCase();

    logger.info('SDK install requested', {
      user: req.user.username,
      sdk,
      version
    });

    const installCommands = {
      nodejs: {
        windows: `winget install OpenJS.NodeJS${version ? `.${version}` : ''}`,
        mac: `brew install node${version ? `@${version}` : ''}`,
        linux: `sudo apt-get install -y nodejs npm`
      },
      python: {
        windows: `winget install Python.Python.3.11`,
        mac: `brew install python@3.11`,
        linux: `sudo apt-get install -y python3 python3-pip`
      },
      java: {
        windows: `winget install Microsoft.OpenJDK.21`,
        mac: `brew install openjdk@21`,
        linux: `sudo apt-get install -y default-jdk`
      },
      dotnet: {
        windows: `winget install Microsoft.DotNet.SDK.8`,
        mac: `brew install --cask dotnet-sdk`,
        linux: `sudo apt-get install -y dotnet-sdk-8.0`
      },
      go: {
        windows: `winget install GoLang.Go`,
        mac: `brew install go`,
        linux: `sudo apt-get install -y golang-go`
      },
      rust: {
        windows: `winget install Rustlang.Rustup`,
        mac: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`,
        linux: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
      },
      ruby: {
        windows: `winget install RubyInstallerTeam.Ruby`,
        mac: `brew install ruby`,
        linux: `sudo apt-get install -y ruby-full`
      },
      php: {
        windows: `winget install PHP.PHP`,
        mac: `brew install php`,
        linux: `sudo apt-get install -y php php-cli php-fpm`
      },
      docker: {
        windows: `winget install Docker.DockerDesktop`,
        mac: `brew install --cask docker`,
        linux: `sudo apt-get install -y docker.io && sudo systemctl start docker`
      },
      git: {
        windows: `winget install Git.Git`,
        mac: `brew install git`,
        linux: `sudo apt-get install -y git`
      },
      android: {
        windows: `winget install Google.AndroidStudio`,
        mac: `brew install --cask android-studio`,
        linux: `sudo snap install android-studio --classic`
      }
    };

    const commands = installCommands[sdk];
    if (!commands) {
      return res.status(400).json({ error: `Unknown SDK: ${sdk}`, available: Object.keys(installCommands) });
    }

    res.json({
      success: true,
      status: 'ready',
      sdk,
      version: version || 'latest',
      install_commands: commands,
      recommended_command: commands.linux, // Backend runs on Linux in dev
      note: 'Use the terminal action in SDK Manager to execute the appropriate command for your OS',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('SDK install failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/sdk/detect
 * Detect installed SDKs
 */
router.post('/api/sdk/detect', verifyToken, (req, res) => {
  res.json({
    status: 'ok',
    message: 'SDK detection is performed locally by the extension',
    note: 'The VS Code extension uses child_process.exec() to detect SDKs locally'
  });
});

module.exports = router;
