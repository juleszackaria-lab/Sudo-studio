const { spawn } = require('child_process');
const { commands } = require('../security/commandWhitelist');
const logger = require('../utils/logger');

const TIMEOUT_MS = parseInt(process.env.EMULATOR_TIMEOUT_MS || '60000', 10);

function runCommand(cmdArgs, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = spawn('docker', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
      resolve({ success: false, error: 'timeout', stdout, stderr });
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message, stdout, stderr });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, code, stdout, stderr });
    });
  });
}

async function start(req, res) {
  try {
    logger.info(`Emulator start requested by ${req.user.username}`);
    const result = await runCommand(commands.start);
    if (!result.success) {
      logger.error('Emulator start failed', result);
      return res.status(500).json({ error: 'Failed to start emulator', details: result });
    }
    logger.info('Emulator started');
    res.json({ message: 'emulator started', details: result.stdout });
  } catch (e) {
    logger.error('Emulator start exception', e);
    res.status(500).json({ error: e.message });
  }
}

async function status(req, res) {
  try {
    logger.info(`Emulator status requested by ${req.user.username}`);
    const result = await runCommand(commands.status);
    if (!result.success && result.code !== 0) {
      // docker ps may return non-zero if no container found; treat gracefully
      return res.json({ running: false, details: result.stdout || result.stderr });
    }
    const out = (result.stdout || '').trim();
    const running = !!out;
    res.json({ running, details: out });
  } catch (e) {
    logger.error('Emulator status exception', e);
    res.status(500).json({ error: e.message });
  }
}

async function stop(req, res) {
  try {
    logger.info(`Emulator stop requested by ${req.user.username}`);
    const result = await runCommand(commands.stop);
    if (!result.success) {
      logger.error('Emulator stop failed', result);
      return res.status(500).json({ error: 'Failed to stop emulator', details: result });
    }
    logger.info('Emulator stopped');
    res.json({ message: 'emulator stopped', details: result.stdout });
  } catch (e) {
    logger.error('Emulator stop exception', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { start, status, stop };
