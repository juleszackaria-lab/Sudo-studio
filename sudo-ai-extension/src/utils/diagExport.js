/**
 * diagExport.js - PROMPT 21 diagnostic export bundle.
 *
 * Builds the "Sudo : Exporter le diagnostic" .zip WITHOUT any secret and
 * WITHOUT any project content (we only ever read the logs folder + injected
 * getters; the workspace is never touched):
 *   manifest.json            generation info + exact file list
 *   versions.json            extension + backend versions, log format version
 *   config-sanitized.json    sudoStudio settings, secret-masked
 *   runtime-state.json       runtime/backend state snapshot, secret-masked
 *   logs/<component>.log.tail.log      recent human-readable lines per component
 *   logs/<component>.log.1.tail.log    previous rotated file (when present)
 *
 * All getters are injected so the bundle is hermetic-testable (no vscode,
 * no axios, no network in this module).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeZip } = require('./minizip');
const { maskSecrets, maskSecretsDeep, resolveLogsDir, FORMAT_VERSION } = require('./techLog');

const DEFAULT_TAIL_LINES = 2000;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

function tailFile(file, maxLines) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const lines = String(text).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return maskSecrets(lines.slice(-(maxLines || DEFAULT_TAIL_LINES)).join('\n')).slice(0, MAX_TAIL_BYTES);
}

function safeJson(v) {
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
  catch (_) { return null; }
}

// opts: { logsDir, tailLines, getExtensionVersion(), getBackendInfo(),
//         getRuntimeState(), getConfig(), nowIso() }
function buildDiagnosticBundle(opts) {
  opts = opts || {};
  const dir = opts.logsDir || resolveLogsDir({});
  const tailN = opts.tailLines || DEFAULT_TAIL_LINES;
  const files = [];
  const push = (name, content) => files.push({ name, data: String(content === undefined || content === null ? '' : content) });

  // Recent human-readable logs only (never .jsonl twins, never the workspace).
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\w[\w-]*\.log(\.\d+)?$/.test(n)).sort(); } catch (_) { names = []; }
  const perComp = {};
  for (const n of names) {
    const m = n.match(/^(\w[\w-]*)\.log(?:\.(\d+))?$/);
    const comp = m[1];
    const rank = m[2] === undefined ? 0 : parseInt(m[2], 10);
    if (!(comp in perComp)) perComp[comp] = [];
    if (rank <= 1) perComp[comp].push(n); // current + previous rotated only
  }
  for (const comp of Object.keys(perComp).sort()) {
    for (const n of perComp[comp]) {
      const t = tailFile(path.join(dir, n), tailN);
      if (t !== null) push('logs/' + n + '.tail.log', t);
    }
  }

  let extVersion = 'unknown';
  try { extVersion = String((opts.getExtensionVersion && opts.getExtensionVersion()) || 'unknown'); } catch (_) {}
  let backendInfo = null;
  try { backendInfo = maskSecretsDeep(safeJson(opts.getBackendInfo ? opts.getBackendInfo() : null), 0); } catch (_) { backendInfo = null; }
  let runtimeState = null;
  try { runtimeState = maskSecretsDeep(safeJson(opts.getRuntimeState ? opts.getRuntimeState() : null), 0); } catch (_) { runtimeState = null; }
  let config = null;
  try { config = maskSecretsDeep(safeJson(opts.getConfig ? opts.getConfig() : null), 0); } catch (_) { config = null; }

  push('versions.json', JSON.stringify({ extension: maskSecrets(extVersion), backend: backendInfo, logFormat: FORMAT_VERSION }, null, 2));
  push('config-sanitized.json', JSON.stringify(config, null, 2));
  push('runtime-state.json', JSON.stringify(runtimeState, null, 2));

  const manifest = {
    generator: 'sudo-studio-diagnostics',
    logFormat: FORMAT_VERSION,
    generatedAt: (opts.nowIso && opts.nowIso()) || new Date().toISOString(),
    logsDir: dir,
    secrets: 'masked ([REDACTED])',
    projectContent: 'never included',
    files: files.map((f) => f.name).concat(['manifest.json']).sort(),
  };
  push('manifest.json', JSON.stringify(manifest, null, 2));
  return { files, manifest };
}

function exportDiagnosticsZip(opts, outPath) {
  const bundle = buildDiagnosticBundle(opts || {});
  const zip = writeZip(bundle.files);
  fs.writeFileSync(outPath, zip);
  return { outPath, bytes: zip.length, files: bundle.manifest.files };
}

module.exports = { buildDiagnosticBundle, exportDiagnosticsZip, tailFile, DEFAULT_TAIL_LINES };
