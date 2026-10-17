// Sudo Agent verify loop + deploy gate (P26-d/f). Check-command detection
// from project markers (explicit .sudo-verify wins), deploy-command
// detection, and the network-policy gate for deploys. Stdlib only,
// ASCII only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function exists(root, rel) {
  try { return fs.statSync(path.join(root, rel)).isFile(); } catch (_) { return false; }
}

function anyExists(root, rels) {
  return rels.some((r) => exists(root, r));
}

function readJson(root, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
  catch (_) { return null; }
}

function globTop(root, ext) {
  try {
    return fs.readdirSync(root).some((f) => f.toLowerCase().endsWith(ext));
  } catch (_) { return false; }
}

// Ordered detection. Returns [{ name, command }], possibly empty.
// An explicit `.sudo-verify` file (one command line) overrides everything.
function detectChecks(root) {
  const vf = path.join(root, '.sudo-verify');
  try {
    const st = fs.statSync(vf);
    if (st.isFile() && st.size > 0 && st.size <= 1024) {
      const cmd = fs.readFileSync(vf, 'utf8').split('\n')[0].trim();
      if (cmd) return [{ name: 'project-verify', command: cmd.slice(0, 500) }];
    }
  } catch (_) {}
  const out = [];
  if (exists(root, 'pubspec.yaml')) {
    out.push({ name: 'flutter analyze', command: 'flutter analyze' });
    out.push({ name: 'flutter test', command: 'flutter test' });
    return out;
  }
  if (exists(root, 'package.json')) {
    const pkg = readJson(root, 'package.json');
    const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    if (scripts && typeof scripts.test === 'string' && scripts.test.trim()) {
      out.push({ name: 'npm test', command: 'npm test' });
      return out;
    }
  }
  if (anyExists(root, ['pytest.ini', 'setup.py', 'setup.cfg', 'pyproject.toml', 'tox.ini'])) {
    out.push({ name: 'pytest', command: 'pytest -q' });
    return out;
  }
  if (exists(root, 'go.mod')) { out.push({ name: 'go test', command: 'go test ./...' }); return out; }
  if (exists(root, 'Cargo.toml')) { out.push({ name: 'cargo test', command: 'cargo test --quiet' }); return out; }
  if (exists(root, 'pom.xml')) { out.push({ name: 'mvn test', command: 'mvn -q test' }); return out; }
  if (globTop(root, '.sln') || globTop(root, '.csproj')) { out.push({ name: 'dotnet test', command: 'dotnet test' }); return out; }
  if (exists(root, 'Makefile') || exists(root, 'makefile')) { out.push({ name: 'make test', command: 'make test' }); return out; }
  return out;
}

// Deploy-command detection (tight: release verbs + deploy scripts).
const DEPLOY_RES = [
  /\b(npm|yarn|pnpm)\s+(run\s+)?[\w:-]*deploy[\w:-]*\b/i,
  /\bflutter\s+build\s+(apk|appbundle|web|ios|windows|linux|macos)\b/i,
  /\bdocker\s+(push|buildx\s+build[^\n]*--push)\b/i,
  /\bkubectl\s+(apply|rollout)\b/i,
  /\bhelm\s+(upgrade|install)\b/i,
  /\b(az|aws|gcloud|heroku|vercel|netlify|firebase|fly|railway|supabase|wrangler|serverless|sam|cdk|terraform\s+apply)\b[^\n]*\b(deploy|publish|release|push|apply)\b/i,
  /(^|[\s;&|])(\.\/)?[\w./-]*deploy\.sh\b/i,
];

function detectDeploy(command) {
  const s = String(command || '');
  for (const re of DEPLOY_RES) {
    re.lastIndex = 0;
    if (re.test(s)) return true;
  }
  return false;
}

// Network policy for deploys (admin-managed, global, never in the project).
function netPolicyFile(home) {
  if (process.env.SUDO_AGENT_NET_POLICY) return String(process.env.SUDO_AGENT_NET_POLICY);
  const h = home || process.env.SUDO_STUDIO_HOME || (function () { try { return os.homedir(); } catch (_) { return process.cwd(); } })();
  return path.join(String(h), '.sudo_studio', 'agent', 'net_policy.json');
}

function deployAllowed(home) {
  try {
    const d = JSON.parse(fs.readFileSync(netPolicyFile(home), 'utf8'));
    return !!(d && d.deployAllowed === true);
  } catch (_) { return false; }
}

module.exports = { detectChecks, detectDeploy, netPolicyFile, deployAllowed };
