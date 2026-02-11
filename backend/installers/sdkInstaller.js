const { exec } = require('child_process');
const path = require('path');

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

  exec(downloadCommand, (downloadError) => {
    if (downloadError) {
      console.error(`Failed to download ${sdkName}:`, downloadError.message);
      return;
    }

    console.log(`${sdkName} downloaded successfully.`);

    exec(extractCommand, (extractError) => {
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

  exec(command, (error) => {
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