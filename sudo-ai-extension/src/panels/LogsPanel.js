/**
 * SUDO STUDIO - Technical logs viewer (PROMPT 21-e).
 * Webview over the unified logs folder: file list per component, tail view
 * with component + level filters and manual/auto refresh. Read-only: it never
 * writes to the journals (one less writer, no feedback loop).
 */
'use strict';

const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const fs = require('fs');
const path = require('path');
const { resolveLogsDir } = require('../utils/techLog');

const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_TAIL_LINES = 2000;

function listLogFiles(logsDir) {
  let names = [];
  try { names = fs.readdirSync(logsDir); } catch (_) { return []; }
  return names
    .filter((n) => /^\w[\w-]*\.log(\.\d+)?$/.test(n))
    .map((n) => {
      let size = -1;
      let mtime = null;
      try {
        const st = fs.statSync(path.join(logsDir, n));
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch (_) { /* ignore */ }
      return { name: n, component: n.replace(/\.log(\.\d+)?$/, ''), size, mtime };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function readTailBytes(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const start = st.size - maxBytes;
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, start);
    const text = buf.toString('utf8');
    return text.slice(text.indexOf('\n') + 1); // drop the first partial line
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function lineLevel(line) {
  const m = /\[(INFO|WARN|ERROR)\s*\]/.exec(line);
  return m ? m[1] : null;
}

function getTail(logsDir, file, maxLines, level) {
  const base = path.basename(String(file || ''));
  if (!/^\w[\w-]*\.log(\.\d+)?$/.test(base)) return { file: base, lines: [], error: 'bad file name' };
  const full = path.join(logsDir, base);
  if (!full.startsWith(logsDir)) return { file: base, lines: [], error: 'outside logs dir' };
  let text = '';
  try { text = readTailBytes(full, MAX_READ_BYTES); } catch (e) { return { file: base, lines: [], error: String((e && e.message) || e) }; }
  let lines = String(text).replace(/\r/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lvl = String(level || 'ALL').toUpperCase();
  if (lvl === 'INFO' || lvl === 'WARN' || lvl === 'ERROR') lines = lines.filter((l) => lineLevel(l) === lvl);
  const n = Math.max(1, Math.min(MAX_TAIL_LINES, parseInt(maxLines, 10) || 300));
  return { file: base, lines: lines.slice(-n), total: lines.length };
}

class LogsPanel {
  constructor(panel, extensionUri, opts) {
    this.panel = panel;
    this.disposables = [];
    this.logsDir = (opts && opts.logsDir) || resolveLogsDir({});
    this.panel.webview.html = this._buildHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m), null, this.disposables);
  }

  static createOrShow(extensionUri, opts) {
    if (LogsPanel.currentPanel) {
      LogsPanel.currentPanel.panel.reveal();
      return LogsPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'sudoStudioLogs', 'Sudo Studio Logs',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    LogsPanel.currentPanel = new LogsPanel(panel, extensionUri, opts);
    return LogsPanel.currentPanel;
  }

  dispose() {
    LogsPanel.currentPanel = undefined;
    try { this.panel.dispose(); } catch (_) {}
    try { this.disposables.forEach((d) => d && d.dispose()); } catch (_) {}
  }

  async handleMessage(msg) {
    if (wvFallback.handlePanelMessage(null, msg)) return;
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'load' || msg.type === 'listFiles') {
        await this.panel.webview.postMessage({ type: 'files', dir: this.logsDir, files: listLogFiles(this.logsDir) });
        return;
      }
      if (msg.type === 'getTail') {
        const tail = getTail(this.logsDir, msg.file, msg.maxLines, msg.level);
        await this.panel.webview.postMessage({ type: 'tail', ...tail });
        return;
      }
      if (msg.type === 'openFolder') {
        await vscode.commands.executeCommand('sudoStudio.openLogsFolder');
        return;
      }
    } catch (_) { /* viewer never crashes the host */ }
  }

  _buildHtml() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sudo Studio Logs</title>
<style>
body { font-family: var(--vscode-font-family, sans-serif); background: #0d1117; color: #e6edf3; padding: 12px; }
h2 { font-size: 15px; margin: 0 0 8px; }
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
select, button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 4px 8px; }
button { cursor: pointer; }
button:hover { background: #30363d; }
#meta { font-size: 11px; color: #7d8590; margin-bottom: 8px; }
#out { background: #010409; border: 1px solid #21262d; border-radius: 4px; padding: 8px; height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.lv-ERROR { color: #f85149; } .lv-WARN { color: #e3b341; } .lv-INFO { color: #7d8590; }
label { font-size: 11px; color: #7d8590; }
</style>
</head>
<body>
${guardSnippet()}
<h2>Technical logs</h2>
<div id="meta">loading...</div>
<div class="row">
<label>File</label><select id="file"></select>
<label>Level</label><select id="level"><option>ALL</option><option>INFO</option><option>WARN</option><option>ERROR</option></select>
<label>Lines</label><select id="lines"><option>100</option><option selected>300</option><option>1000</option><option>2000</option></select>
<button onclick="refresh()">Refresh</button>
<button onclick="openFolder()">Open logs folder</button>
<label><input type="checkbox" id="auto" onchange="toggleAuto(this.checked)"> auto (5s)</label>
</div>
<pre id="out"></pre>
<script>
var vscode = acquireVsCodeApi();
var timer = null;
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function refresh() {
  var f = document.getElementById('file').value;
  vscode.postMessage({ type: 'getTail', file: f, maxLines: document.getElementById('lines').value, level: document.getElementById('level').value });
}
function openFolder() { vscode.postMessage({ type: 'openFolder' }); }
function toggleAuto(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(refresh, 5000);
}
window.addEventListener('message', function(e) {
  var m = e.data || {};
  if (m.type === 'files') {
    document.getElementById('meta').textContent = m.dir + ' (' + m.files.length + ' files)';
    var sel = document.getElementById('file');
    sel.innerHTML = '';
    m.files.forEach(function(f) {
      var o = document.createElement('option');
      o.value = f.name; o.textContent = f.name + ' (' + f.size + ' b)';
      sel.appendChild(o);
    });
    if (m.files.length) refresh();
    return;
  }
  if (m.type === 'tail') {
    var html = '';
    (m.lines || []).forEach(function(l) {
      var lv = (l.match(/\\[(INFO|WARN|ERROR)\\s*\\]/) || [])[1] || 'INFO';
      html += '<span class="lv-' + lv + '">' + esc(l) + '</span>\\n';
    });
    document.getElementById('out').innerHTML = html || '(empty)';
    document.getElementById('out').scrollTop = 1e9;
  }
});
vscode.postMessage({ type: 'load' });
</script>
</body>
</html>`;
  }
}

module.exports = { LogsPanel, listLogFiles, getTail, lineLevel };
