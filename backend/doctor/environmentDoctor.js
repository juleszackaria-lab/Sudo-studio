const { exec } = require('child_process');

/**
 * Checks if a command exists on the system.
 * @param {string} command - The command to check.
 * @returns {Promise<boolean>} - True if the command exists, false otherwise.
 */
const commandExists = (command) => {
  return new Promise((resolve) => {
    exec(`${command} --version`, (error) => {
      resolve(!error);
    });
  });
};

/**
 * Checks the environment for required tools and returns a report.
 * @returns {Promise<object>} - A report of the environment status.
 */
const checkEnvironment = async () => {
  const tools = [
    { name: 'Node.js', command: 'node' },
    { name: 'npm', command: 'npm' },
    { name: 'Git', command: 'git' },
    { name: 'Java (JDK)', command: 'java' },
    { name: 'Flutter', command: 'flutter' },
    { name: 'Android SDK', command: 'adb' },
  ];

  const report = {};

  for (const tool of tools) {
    const exists = await commandExists(tool.command);
    report[tool.name] = exists ? 'Installed' : 'Missing';
  }

  return report;
};

module.exports = {
  checkEnvironment,
};