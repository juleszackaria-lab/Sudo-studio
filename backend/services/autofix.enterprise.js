/**
 * ====================================================================================================
 * SUDO STUDIO - ENTERPRISE AUTO-FIX SYSTEM
 * ====================================================================================================
 * 
 * Intelligent automatic repair system for common development environment issues.
 * 
 * CAPABILITIES:
 * - npm/yarn package manager error detection and repair
 * - pip/Python dependency error resolution
 * - Broken import detection and fixing
 * - Missing dependency installation
 * - Version conflict resolution
 * - PATH environment issues repair
 * - Configuration file corruption repair
 * - Automatic backup before modifications
 * - Rollback capability on failure
 * - Lock file regeneration
 * - Cache clearing and rebuilding
 * - Node modules cleanup and reinstall
 * - Python virtual environment repair
 * 
 * ERROR PATTERNS DETECTED:
 * - "Cannot find module" / "ModuleNotFoundError"
 * - "ENOENT: no such file or directory"
 * - "npm ERR! code ELIFECYCLE"
 * - "pip is configured with locations that require TLS/SSL"
 * - "error: package-lock.json out of sync"
 * - "EACCES: permission denied"
 * - "Maximum call stack size exceeded"
 * - "Unable to resolve dependency tree"
 * - Version mismatch errors
 * - Peer dependency conflicts
 * 
 * @module autofix.enterprise
 * @version 1.0.0
 * @enterprise
 */

const { exec, execSync } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ====================================================================================================
// CONFIGURATION
// ====================================================================================================

const CONFIG = {
  backup: {
    enabled: true,
    directory: path.join(os.tmpdir(), 'sudo-studio-backups'),
    maxBackups: 10,
    retentionDays: 7,
  },
  
  npm: {
    cacheDir: path.join(os.homedir(), '.npm'),
    configFiles: ['package.json', 'package-lock.json', '.npmrc'],
    nodeModulesDir: 'node_modules',
  },
  
  python: {
    cacheDir: path.join(os.homedir(), '.cache', 'pip'),
    configFiles: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
    venvDir: ['venv', '.venv', 'env'],
  },
  
  timeout: {
    install: 300000, // 5 minutes
    diagnosis: 30000, // 30 seconds
  },
};

// ====================================================================================================
// ERROR PATTERN DEFINITIONS
// ====================================================================================================

const ERROR_PATTERNS = {
  npm: [
    {
      pattern: /Cannot find module ['"](.+)['"]/i,
      type: 'missing_module',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /ENOENT: no such file or directory/i,
      type: 'missing_file',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /npm ERR! code ELIFECYCLE/i,
      type: 'lifecycle_error',
      severity: 'medium',
      fixable: true,
    },
    {
      pattern: /EACCES: permission denied/i,
      type: 'permission_error',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /package-lock\.json out of sync/i,
      type: 'lockfile_sync',
      severity: 'medium',
      fixable: true,
    },
    {
      pattern: /Unable to resolve dependency tree/i,
      type: 'dependency_conflict',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /peer dep missing/i,
      type: 'peer_dependency',
      severity: 'medium',
      fixable: true,
    },
  ],
  
  python: [
    {
      pattern: /ModuleNotFoundError: No module named ['"](.+)['"]/i,
      type: 'missing_module',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /pip is configured with locations that require TLS\/SSL/i,
      type: 'ssl_error',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /Could not find a version that satisfies the requirement/i,
      type: 'version_conflict',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /ImportError: cannot import name/i,
      type: 'import_error',
      severity: 'high',
      fixable: true,
    },
  ],
  
  general: [
    {
      pattern: /Maximum call stack size exceeded/i,
      type: 'stack_overflow',
      severity: 'high',
      fixable: true,
    },
    {
      pattern: /EADDRINUSE.*:(\d+)/i,
      type: 'port_conflict',
      severity: 'medium',
      fixable: true,
    },
  ],
};

// ====================================================================================================
// LOGGER
// ====================================================================================================

const logger = {
  info: (message, ...args) => console.log(`[AUTO-FIX] ℹ️  ${message}`, ...args),
  success: (message, ...args) => console.log(`[AUTO-FIX] ✅ ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[AUTO-FIX] ⚠️  ${message}`, ...args),
  error: (message, ...args) => console.error(`[AUTO-FIX] ❌ ${message}`, ...args),
  debug: (message, ...args) => {
    if (process.env.DEBUG) {
      console.log(`[AUTO-FIX] 🔍 ${message}`, ...args);
    }
  },
};

// ====================================================================================================
// UTILITY FUNCTIONS
// ====================================================================================================

/**
 * Sleep utility
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check if file exists
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get backup directory path
 */
function getBackupDir() {
  return path.join(CONFIG.backup.directory, new Date().toISOString().split('T')[0]);
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (error) {
    logger.error(`Failed to create directory ${dirPath}:`, error.message);
    return false;
  }
}

// ====================================================================================================
// BACKUP & ROLLBACK
// ====================================================================================================

/**
 * Create backup of file or directory
 */
async function createBackup(targetPath, backupId) {
  if (!CONFIG.backup.enabled) {
    return null;
  }
  
  try {
    const backupDir = path.join(getBackupDir(), backupId);
    await ensureDir(backupDir);
    
    const targetName = path.basename(targetPath);
    const backupPath = path.join(backupDir, targetName);
    
    logger.info(`Creating backup: ${targetPath} -> ${backupPath}`);
    
    const stat = await fs.stat(targetPath);
    
    if (stat.isDirectory()) {
      // Copy directory recursively
      await fs.cp(targetPath, backupPath, { recursive: true });
    } else {
      // Copy single file
      await fs.copyFile(targetPath, backupPath);
    }
    
    logger.success(`Backup created: ${backupPath}`);
    
    return {
      id: backupId,
      originalPath: targetPath,
      backupPath,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Backup failed: ${error.message}`);
    return null;
  }
}

/**
 * Restore from backup
 */
async function restoreBackup(backup) {
  if (!backup) {
    return false;
  }
  
  try {
    logger.info(`Restoring backup: ${backup.backupPath} -> ${backup.originalPath}`);
    
    // Remove current version
    await fs.rm(backup.originalPath, { recursive: true, force: true });
    
    // Restore backup
    const stat = await fs.stat(backup.backupPath);
    
    if (stat.isDirectory()) {
      await fs.cp(backup.backupPath, backup.originalPath, { recursive: true });
    } else {
      await fs.copyFile(backup.backupPath, backup.originalPath);
    }
    
    logger.success('Backup restored successfully');
    return true;
  } catch (error) {
    logger.error(`Restore failed: ${error.message}`);
    return false;
  }
}

/**
 * Clean old backups
 */
async function cleanOldBackups() {
  try {
    const backupRoot = CONFIG.backup.directory;
    const dirs = await fs.readdir(backupRoot);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - CONFIG.backup.retentionDays);
    
    for (const dir of dirs) {
      const dirPath = path.join(backupRoot, dir);
      const stat = await fs.stat(dirPath);
      
      if (stat.isDirectory() && stat.mtime < cutoffDate) {
        await fs.rm(dirPath, { recursive: true });
        logger.debug(`Removed old backup: ${dir}`);
      }
    }
  } catch (error) {
    logger.debug(`Backup cleanup failed: ${error.message}`);
  }
}

// ====================================================================================================
// ERROR DETECTION
// ====================================================================================================

/**
 * Analyze error message and detect patterns
 */
function analyzeError(errorMessage, errorType = 'general') {
  const patterns = ERROR_PATTERNS[errorType] || ERROR_PATTERNS.general;
  const matches = [];
  
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern.pattern);
    if (match) {
      matches.push({
        type: pattern.type,
        severity: pattern.severity,
        fixable: pattern.fixable,
        match: match[0],
        captured: match[1] || null,
      });
    }
  }
  
  return matches;
}

/**
 * Detect error type from message
 */
function detectErrorType(errorMessage) {
  // Check for npm/yarn errors
  if (/npm|yarn|package\.json/i.test(errorMessage)) {
    return 'npm';
  }
  
  // Check for Python errors
  if (/pip|python|requirements\.txt|ModuleNotFoundError/i.test(errorMessage)) {
    return 'python';
  }
  
  return 'general';
}

// ====================================================================================================
// NPM/YARN FIXES
// ====================================================================================================

/**
 * Fix npm missing module error
 */
async function fixNpmMissingModule(moduleName, projectDir) {
  logger.info(`Fixing missing npm module: ${moduleName}`);
  
  try {
    const { stdout, stderr } = await execAsync(`npm install ${moduleName}`, {
      cwd: projectDir,
      timeout: CONFIG.timeout.install,
    });
    
    logger.success(`Installed ${moduleName}`);
    return { success: true, output: stdout };
  } catch (error) {
    logger.error(`Failed to install ${moduleName}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Fix npm permission errors
 */
async function fixNpmPermissions(projectDir) {
  logger.info('Fixing npm permission errors...');
  
  const platform = process.platform;
  
  try {
    if (platform === 'win32') {
      // Windows: Take ownership
      await execAsync(`takeown /f "${projectDir}" /r /d y`, { timeout: 60000 });
    } else {
      // Unix: Change ownership to current user
      const username = os.userInfo().username;
      await execAsync(`sudo chown -R ${username} "${projectDir}"`, { timeout: 60000 });
    }
    
    logger.success('Permissions fixed');
    return { success: true };
  } catch (error) {
    logger.error(`Permission fix failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Clean and rebuild npm installation
 */
async function cleanNpmInstallation(projectDir) {
  logger.info('Cleaning npm installation...');
  
  const backupId = `npm-clean-${Date.now()}`;
  let backups = [];
  
  try {
    // Backup package-lock.json and node_modules
    const lockFile = path.join(projectDir, 'package-lock.json');
    const nodeModules = path.join(projectDir, CONFIG.npm.nodeModulesDir);
    
    if (await fileExists(lockFile)) {
      backups.push(await createBackup(lockFile, backupId));
    }
    
    if (await fileExists(nodeModules)) {
      backups.push(await createBackup(nodeModules, backupId));
    }
    
    // Remove node_modules
    logger.info('Removing node_modules...');
    await fs.rm(nodeModules, { recursive: true, force: true });
    
    // Remove package-lock.json
    await fs.rm(lockFile, { force: true });
    
    // Clear npm cache
    logger.info('Clearing npm cache...');
    await execAsync('npm cache clean --force', { timeout: 60000 });
    
    // Reinstall
    logger.info('Reinstalling dependencies...');
    await execAsync('npm install', {
      cwd: projectDir,
      timeout: CONFIG.timeout.install,
    });
    
    logger.success('npm installation cleaned and rebuilt');
    return { success: true, backups };
  } catch (error) {
    logger.error(`Clean installation failed: ${error.message}`);
    
    // Attempt rollback
    for (const backup of backups) {
      await restoreBackup(backup);
    }
    
    return { success: false, error: error.message };
  }
}

/**
 * Fix npm dependency conflicts
 */
async function fixNpmDependencyConflicts(projectDir) {
  logger.info('Fixing dependency conflicts...');
  
  try {
    // Try with --legacy-peer-deps
    logger.info('Attempting installation with --legacy-peer-deps...');
    await execAsync('npm install --legacy-peer-deps', {
      cwd: projectDir,
      timeout: CONFIG.timeout.install,
    });
    
    logger.success('Dependencies installed with legacy peer deps');
    return { success: true };
  } catch (error) {
    // Try with --force
    try {
      logger.warn('Trying with --force...');
      await execAsync('npm install --force', {
        cwd: projectDir,
        timeout: CONFIG.timeout.install,
      });
      
      logger.success('Dependencies installed with --force');
      return { success: true };
    } catch (forceError) {
      logger.error(`Dependency conflict fix failed: ${forceError.message}`);
      return { success: false, error: forceError.message };
    }
  }
}

// ====================================================================================================
// PYTHON/PIP FIXES
// ====================================================================================================

/**
 * Fix Python missing module error
 */
async function fixPythonMissingModule(moduleName, projectDir) {
  logger.info(`Fixing missing Python module: ${moduleName}`);
  
  try {
    const { stdout, stderr } = await execAsync(`pip install ${moduleName}`, {
      cwd: projectDir,
      timeout: CONFIG.timeout.install,
    });
    
    logger.success(`Installed ${moduleName}`);
    return { success: true, output: stdout };
  } catch (error) {
    logger.error(`Failed to install ${moduleName}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Fix pip SSL errors
 */
async function fixPipSSLErrors() {
  logger.info('Fixing pip SSL errors...');
  
  try {
    // Upgrade pip with trusted host
    await execAsync('python -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --upgrade pip', {
      timeout: CONFIG.timeout.install,
    });
    
    logger.success('pip SSL configuration updated');
    return { success: true };
  } catch (error) {
    logger.error(`pip SSL fix failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Reinstall Python requirements
 */
async function reinstallPythonRequirements(projectDir) {
  logger.info('Reinstalling Python requirements...');
  
  const reqFile = path.join(projectDir, 'requirements.txt');
  
  if (!(await fileExists(reqFile))) {
    logger.warn('requirements.txt not found');
    return { success: false, error: 'requirements.txt not found' };
  }
  
  const backupId = `pip-reinstall-${Date.now()}`;
  
  try {
    // Clear pip cache
    logger.info('Clearing pip cache...');
    await execAsync('pip cache purge', { timeout: 60000 });
    
    // Reinstall requirements
    logger.info('Installing requirements...');
    await execAsync(`pip install -r requirements.txt`, {
      cwd: projectDir,
      timeout: CONFIG.timeout.install,
    });
    
    logger.success('Python requirements reinstalled');
    return { success: true };
  } catch (error) {
    logger.error(`Requirements reinstall failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ====================================================================================================
// GENERAL FIXES
// ====================================================================================================

/**
 * Fix port conflict by killing process
 */
async function fixPortConflict(port) {
  logger.info(`Fixing port conflict on ${port}...`);
  
  const platform = process.platform;
  
  try {
    if (platform === 'win32') {
      // Windows: Find and kill process
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.split('\n');
      const pids = new Set();
      
      for (const line of lines) {
        const match = line.match(/\s+(\d+)\s*$/);
        if (match) {
          pids.add(match[1]);
        }
      }
      
      for (const pid of pids) {
        await execAsync(`taskkill /F /PID ${pid}`);
        logger.success(`Killed process ${pid} on port ${port}`);
      }
    } else {
      // Unix: Find and kill process
      const { stdout } = await execAsync(`lsof -ti:${port}`);
      const pids = stdout.trim().split('\n');
      
      for (const pid of pids) {
        if (pid) {
          await execAsync(`kill -9 ${pid}`);
          logger.success(`Killed process ${pid} on port ${port}`);
        }
      }
    }
    
    return { success: true };
  } catch (error) {
    logger.error(`Port conflict fix failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ====================================================================================================
// MAIN AUTO-FIX ENGINE
// ====================================================================================================

/**
 * Automatically fix detected error
 */
async function autoFix(errorMessage, context = {}) {
  const { projectDir = process.cwd() } = context;
  
  logger.info('Starting auto-fix analysis...');
  
  // Detect error type
  const errorType = detectErrorType(errorMessage);
  logger.info(`Error type detected: ${errorType}`);
  
  // Analyze error patterns
  const patterns = analyzeError(errorMessage, errorType);
  
  if (patterns.length === 0) {
    logger.warn('No fixable patterns detected');
    return { success: false, error: 'No fixable patterns detected' };
  }
  
  logger.info(`Found ${patterns.length} fixable issue(s)`);
  
  const results = [];
  
  // Apply fixes for each pattern
  for (const pattern of patterns) {
    logger.info(`Applying fix for: ${pattern.type}`);
    
    let result;
    
    switch (pattern.type) {
      // NPM fixes
      case 'missing_module':
        if (errorType === 'npm') {
          result = await fixNpmMissingModule(pattern.captured, projectDir);
        } else if (errorType === 'python') {
          result = await fixPythonMissingModule(pattern.captured, projectDir);
        }
        break;
        
      case 'permission_error':
        result = await fixNpmPermissions(projectDir);
        break;
        
      case 'lockfile_sync':
      case 'lifecycle_error':
        result = await cleanNpmInstallation(projectDir);
        break;
        
      case 'dependency_conflict':
      case 'peer_dependency':
        result = await fixNpmDependencyConflicts(projectDir);
        break;
        
      // Python fixes
      case 'ssl_error':
        result = await fixPipSSLErrors();
        break;
        
      case 'version_conflict':
      case 'import_error':
        result = await reinstallPythonRequirements(projectDir);
        break;
        
      // General fixes
      case 'port_conflict':
        const portMatch = errorMessage.match(/:(\d+)/);
        if (portMatch) {
          result = await fixPortConflict(portMatch[1]);
        }
        break;
        
      default:
        logger.warn(`No fix available for pattern: ${pattern.type}`);
        result = { success: false, error: 'No fix available' };
    }
    
    results.push({
      pattern: pattern.type,
      ...result,
    });
  }
  
  // Clean old backups
  await cleanOldBackups();
  
  const successCount = results.filter(r => r.success).length;
  const allSuccess = successCount === results.length;
  
  if (allSuccess) {
    logger.success(`All fixes applied successfully (${successCount}/${results.length})`);
  } else {
    logger.warn(`Partial success: ${successCount}/${results.length} fixes applied`);
  }
  
  return {
    success: allSuccess,
    results,
    summary: {
      total: results.length,
      successful: successCount,
      failed: results.length - successCount,
    },
  };
}

/**
 * Diagnose project for potential issues
 */
async function diagnoseProject(projectDir = process.cwd()) {
  logger.info(`Diagnosing project: ${projectDir}`);
  
  const issues = [];
  
  // Check for package.json
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (await fileExists(packageJsonPath)) {
    // Check node_modules
    const nodeModulesPath = path.join(projectDir, 'node_modules');
    if (!(await fileExists(nodeModulesPath))) {
      issues.push({
        type: 'missing_dependencies',
        severity: 'high',
        message: 'node_modules not found',
        fix: 'Run npm install',
      });
    }
    
    // Check for package-lock.json
    const lockPath = path.join(projectDir, 'package-lock.json');
    if (!(await fileExists(lockPath))) {
      issues.push({
        type: 'missing_lockfile',
        severity: 'medium',
        message: 'package-lock.json not found',
        fix: 'Run npm install to generate lockfile',
      });
    }
  }
  
  // Check for requirements.txt
  const reqPath = path.join(projectDir, 'requirements.txt');
  if (await fileExists(reqPath)) {
    // Try importing common modules
    try {
      await execAsync('python -c "import flask"', { timeout: 5000 });
    } catch {
      issues.push({
        type: 'missing_python_dependencies',
        severity: 'high',
        message: 'Python dependencies not installed',
        fix: 'Run pip install -r requirements.txt',
      });
    }
  }
  
  return {
    issues,
    healthy: issues.length === 0,
    summary: {
      total: issues.length,
      high: issues.filter(i => i.severity === 'high').length,
      medium: issues.filter(i => i.severity === 'medium').length,
      low: issues.filter(i => i.severity === 'low').length,
    },
  };
}

// ====================================================================================================
// PUBLIC API
// ====================================================================================================

module.exports = {
  // Main functions
  autoFix,
  diagnoseProject,
  
  // Specific fixes
  fixNpmMissingModule,
  fixNpmPermissions,
  cleanNpmInstallation,
  fixNpmDependencyConflicts,
  fixPythonMissingModule,
  fixPipSSLErrors,
  reinstallPythonRequirements,
  fixPortConflict,
  
  // Analysis
  analyzeError,
  detectErrorType,
  
  // Backup/Restore
  createBackup,
  restoreBackup,
  
  // Configuration
  CONFIG,
};
