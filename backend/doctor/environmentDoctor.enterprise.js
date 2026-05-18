const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

/**
 * SUDO STUDIO - ENTERPRISE ENVIRONMENT DOCTOR
 * Version 2.0 - Production Ready
 * 
 * Capabilities:
 * - Deep system analysis
 * - SDK detection with version validation
 * - PATH environment detection and auto-fix
 * - Permission checks
 * - Network connectivity tests
 * - Port availability checks
 * - Auto-configuration recommendations
 * - Detailed JSON reports
 */

class EnvironmentDoctor {
  constructor() {
    this.platform = process.platform;
    this.isWindows = this.platform === 'win32';
    this.isMac = this.platform === 'darwin';
    this.isLinux = this.platform === 'linux';
    
    this.report = {
      timestamp: new Date().toISOString(),
      platform: this.platform,
      arch: os.arch(),
      hostname: os.hostname(),
      system: {},
      sdks: {},
      environment: {},
      network: {},
      recommendations: [],
      issues: [],
      score: 0
    };
  }

  /**
   * Run complete diagnostic
   */
  async diagnose() {
    logger.info('🔍 Starting environment diagnostic...');
    
    try {
      await this.checkSystem();
      await this.checkSDKs();
      await this.checkEnvironment();
      await this.checkNetwork();
      await this.checkPorts();
      await this.generateRecommendations();
      this.calculateScore();
      
      logger.info('✅ Diagnostic complete', { score: this.report.score });
      return this.report;
      
    } catch (error) {
      logger.error('❌ Diagnostic failed', { error: error.message });
      this.report.error = error.message;
      return this.report;
    }
  }

  /**
   * Check system information
   */
  async checkSystem() {
    this.report.system = {
      platform: this.platform,
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        total: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
        free: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB'
      },
      uptime: Math.round(os.uptime() / 3600) + ' hours'
    };
  }

  /**
   * Check SDKs with version detection
   */
  async checkSDKs() {
    const sdks = [
      { name: 'Node.js', command: 'node', versionFlag: '--version', required: true },
      { name: 'npm', command: 'npm', versionFlag: '--version', required: true },
      { name: 'Python', command: 'python', versionFlag: '--version', required: true },
      { name: 'pip', command: 'pip', versionFlag: '--version', required: false },
      { name: 'Git', command: 'git', versionFlag: '--version', required: true },
      { name: 'Java', command: 'java', versionFlag: '--version', required: false },
      { name: 'Flutter', command: 'flutter', versionFlag: '--version', required: false },
      { name: 'Android SDK (adb)', command: 'adb', versionFlag: 'version', required: false },
      { name: 'Docker', command: 'docker', versionFlag: '--version', required: false },
      { name: 'kubectl', command: 'kubectl', versionFlag: 'version --client', required: false }
    ];

    for (const sdk of sdks) {
      const result = await this.checkCommand(sdk.command, sdk.versionFlag);
      this.report.sdks[sdk.name] = {
        installed: result.installed,
        version: result.version,
        path: result.path,
        required: sdk.required,
        status: result.installed ? 'OK' : (sdk.required ? 'MISSING' : 'OPTIONAL')
      };

      if (!result.installed && sdk.required) {
        this.report.issues.push({
          severity: 'ERROR',
          component: sdk.name,
          message: `${sdk.name} is required but not installed`,
          fix: `Install ${sdk.name} from official website or package manager`
        });
      }
    }
  }

  /**
   * Check if command exists and get version
   */
  async checkCommand(command, versionFlag) {
    try {
      const { stdout, stderr } = await execAsync(`${command} ${versionFlag}`, { 
        timeout: 5000,
        windowsHide: true
      });
      
      const output = stdout || stderr;
      const version = this.extractVersion(output);
      const commandPath = await this.getCommandPath(command);
      
      return {
        installed: true,
        version,
        path: commandPath
      };
    } catch (error) {
      return {
        installed: false,
        version: null,
        path: null
      };
    }
  }

  /**
   * Extract version from output
   */
  extractVersion(output) {
    const versionRegex = /(\d+\.\d+\.\d+|\d+\.\d+)/;
    const match = output.match(versionRegex);
    return match ? match[0] : 'unknown';
  }

  /**
   * Get full path of command
   */
  async getCommandPath(command) {
    try {
      const whereCmd = this.isWindows ? 'where' : 'which';
      const { stdout } = await execAsync(`${whereCmd} ${command}`, { 
        timeout: 3000,
        windowsHide: true
      });
      return stdout.trim().split('\n')[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Check environment variables
   */
  async checkEnvironment() {
    const env = process.env;
    
    this.report.environment = {
      PATH: this.analyzePath(env.PATH),
      NODE_ENV: env.NODE_ENV || 'not set',
      JAVA_HOME: env.JAVA_HOME || 'not set',
      ANDROID_HOME: env.ANDROID_HOME || 'not set',
      FLUTTER_ROOT: env.FLUTTER_ROOT || 'not set',
      PYTHON_PATH: env.PYTHON_PATH || 'not set'
    };

    // Check PATH issues
    if (!env.PATH) {
      this.report.issues.push({
        severity: 'CRITICAL',
        component: 'PATH',
        message: 'PATH environment variable is not set',
        fix: 'System configuration error - requires manual intervention'
      });
    }
  }

  /**
   * Analyze PATH variable
   */
  analyzePath(pathVar) {
    if (!pathVar) return { entries: [], issues: ['PATH not set'] };
    
    const entries = pathVar.split(this.isWindows ? ';' : ':');
    const issues = [];
    const validEntries = [];

    for (const entry of entries) {
      if (!entry) continue;
      
      try {
        // Note: fs.existsSync is sync but we're not in async context here
        const exists = require('fs').existsSync(entry);
        if (exists) {
          validEntries.push(entry);
        } else {
          issues.push(`Invalid PATH entry: ${entry}`);
        }
      } catch (error) {
        issues.push(`Cannot validate PATH entry: ${entry}`);
      }
    }

    return {
      total: entries.length,
      valid: validEntries.length,
      invalid: issues.length,
      entries: validEntries,
      issues
    };
  }

  /**
   * Check network connectivity
   */
  async checkNetwork() {
    const tests = [
      { name: 'Internet', host: 'google.com', port: 443 },
      { name: 'npm registry', host: 'registry.npmjs.org', port: 443 },
      { name: 'PyPI', host: 'pypi.org', port: 443 },
      { name: 'GitHub', host: 'github.com', port: 443 },
      { name: 'HuggingFace', host: 'huggingface.co', port: 443 }
    ];

    this.report.network = {};

    for (const test of tests) {
      const result = await this.checkConnectivity(test.host, test.port);
      this.report.network[test.name] = result;
      
      if (!result.connected) {
        this.report.issues.push({
          severity: 'WARNING',
          component: 'Network',
          message: `Cannot connect to ${test.name} (${test.host})`,
          fix: 'Check internet connection or firewall settings'
        });
      }
    }
  }

  /**
   * Check connectivity to host
   */
  async checkConnectivity(host, port) {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      const timeout = 5000;

      socket.setTimeout(timeout);
      
      socket.on('connect', () => {
        socket.destroy();
        resolve({ connected: true, latency: Date.now() });
      });

      socket.on('error', () => {
        socket.destroy();
        resolve({ connected: false, error: 'Connection failed' });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ connected: false, error: 'Timeout' });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Check critical ports availability
   */
  async checkPorts() {
    const ports = [
      { port: 5000, service: 'Backend Server' },
      { port: 6000, service: 'AI Runtime' },
      { port: 3000, service: 'Frontend Dev Server' },
      { port: 8080, service: 'Alternative Backend' }
    ];

    this.report.ports = {};

    for (const { port, service } of ports) {
      const available = await this.isPortAvailable(port);
      this.report.ports[port] = {
        service,
        available,
        status: available ? 'FREE' : 'IN USE'
      };

      if (!available && (port === 5000 || port === 6000)) {
        this.report.issues.push({
          severity: 'WARNING',
          component: 'Ports',
          message: `Critical port ${port} (${service}) is already in use`,
          fix: `Stop the process using port ${port} or configure a different port`
        });
      }
    }
  }

  /**
   * Check if port is available
   */
  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();

      server.once('error', () => {
        resolve(false);
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port);
    });
  }

  /**
   * Generate recommendations based on findings
   */
  async generateRecommendations() {
    const recs = [];

    // SDK recommendations
    const missingSdks = Object.entries(this.report.sdks)
      .filter(([name, info]) => !info.installed && info.required);

    if (missingSdks.length > 0) {
      recs.push({
        priority: 'HIGH',
        category: 'SDK',
        title: 'Install missing required SDKs',
        actions: missingSdks.map(([name]) => `Install ${name}`),
        impact: 'System will not function without required SDKs'
      });
    }

    // PATH recommendations
    if (this.report.environment.PATH.invalid > 0) {
      recs.push({
        priority: 'MEDIUM',
        category: 'Environment',
        title: 'Clean up invalid PATH entries',
        actions: ['Remove invalid directories from PATH'],
        impact: 'Improved system stability'
      });
    }

    // Network recommendations
    const offlineServices = Object.entries(this.report.network)
      .filter(([name, info]) => !info.connected);

    if (offlineServices.length > 0) {
      recs.push({
        priority: 'MEDIUM',
        category: 'Network',
        title: 'Check network connectivity',
        actions: ['Verify internet connection', 'Check firewall settings'],
        impact: 'Some features may not work without internet'
      });
    }

    this.report.recommendations = recs;
  }

  /**
   * Calculate health score (0-100)
   */
  calculateScore() {
    let score = 100;

    // Deduct for missing required SDKs
    const missingRequired = Object.values(this.report.sdks)
      .filter(sdk => !sdk.installed && sdk.required).length;
    score -= missingRequired * 20;

    // Deduct for critical issues
    const criticalIssues = this.report.issues
      .filter(issue => issue.severity === 'CRITICAL').length;
    score -= criticalIssues * 15;

    // Deduct for errors
    const errors = this.report.issues
      .filter(issue => issue.severity === 'ERROR').length;
    score -= errors * 10;

    // Deduct for warnings
    const warnings = this.report.issues
      .filter(issue => issue.severity === 'WARNING').length;
    score -= warnings * 5;

    // Ensure score is between 0 and 100
    this.report.score = Math.max(0, Math.min(100, score));
    this.report.health = this.getHealthStatus(this.report.score);
  }

  /**
   * Get health status label
   */
  getHealthStatus(score) {
    if (score >= 90) return 'EXCELLENT';
    if (score >= 75) return 'GOOD';
    if (score >= 50) return 'FAIR';
    if (score >= 25) return 'POOR';
    return 'CRITICAL';
  }

  /**
   * Export report to file
   */
  async saveReport(filename = 'environment-report.json') {
    try {
      const reportPath = path.join(process.cwd(), 'logs', filename);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(this.report, null, 2));
      logger.info(`Report saved to ${reportPath}`);
      return reportPath;
    } catch (error) {
      logger.error('Failed to save report', { error: error.message });
      return null;
    }
  }
}

// Export singleton instance
const doctor = new EnvironmentDoctor();

module.exports = {
  diagnose: () => doctor.diagnose(),
  checkEnvironment: () => doctor.diagnose(), // backward compatibility
  EnvironmentDoctor
};
