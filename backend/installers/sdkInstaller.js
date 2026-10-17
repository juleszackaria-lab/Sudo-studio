const { exec } = require('child_process');
const path = require('path');

// P21-g: journal every command (exact cmd, exit code, last-30 output, ms).
function loggedExec(cmd, cb) {
  const t0 = Date.now();
  exec(cmd, (error, stdout, stderr) => {
    try {
      const techLog = require('../utils/techLog');
      techLog.sharedLog('sdk').info('exec', { cmd: String(cmd),
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        durationMs: Date.now() - t0, out: techLog.tailLines((stdout || '') + '\n' + (stderr || '')) });
    } catch (_) { /* never break installs */ }
    cb(error, stdout, stderr);
  });
}

/**
 * Downloads and installs a given SDK.
 * @param {string} sdkName - The name of the SDK to install.
 * @param {string} downloadUrl - The URL to download the SDK.
 * @param {string} installPath - The path where the SDK should be installed.
 */
const installSDK = (sdkName, downloadUrl, installPath) => {
  console.log(`Starting installation for ${sdkName}...`);

  const downloadCommand = `curl -o ${sdkName}.zip ${downloadUrl}`;
  const extractCommand = `unzip ${sdkName}.zip -d ${installPath}`;

  loggedExec(downloadCommand, (downloadError) => {
    if (downloadError) {
      console.error(`Failed to download ${sdkName}:`, downloadError.message);
      return;
    }

    console.log(`${sdkName} downloaded successfully.`);

    loggedExec(extractCommand, (extractError) => {
      if (extractError) {
        console.error(`Failed to extract ${sdkName}:`, extractError.message);
        return;
      }

      console.log(`${sdkName} installed successfully at ${installPath}.`);
    });
  });
};

/**
 * Configures the system PATH to include the given directory.
 * @param {string} newPath - The directory to add to the PATH.
 */
const configurePath = (newPath) => {
  console.log(`Adding ${newPath} to system PATH...`);

  const command = process.platform === 'win32'
    ? `setx PATH "%PATH%;${newPath}"`
    : `export PATH=$PATH:${newPath}`;

  loggedExec(command, (error) => {
    if (error) {
      console.error(`Failed to update PATH:`, error.message);
      return;
    }

    console.log(`PATH updated successfully with ${newPath}.`);
  });
};

module.exports = {
  installSDK,
  configurePath,
};