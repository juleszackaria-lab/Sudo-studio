/**
 * SUDO STUDIO - Technical logs viewer (PROMPT 21-e, fixed by PROMPT 58).
 *
 * P58 constat: choosing a file did not change the displayed content and the
 * level did not filter anything. Root causes fixed here:
 *   - the file <select> had NO change handler, so picking a file never
 *     re-read anything (the view kept whatever the first refresh loaded);
 *   - the level <select> had no change handler either, and filtering only
 *     understood "[INFO ]"-style text lines (JSON journals were never parsed);
 *   - there was no component filter, no text search, no rotation awareness.
 *
 * Everything about reading/filtering lives in ../logs/logSource.js; this file
 * is the VS Code panel + webview. Read-only: the viewer never writes a journal.
 */
'use strict';

const vscode = require('vscode');
const wvFallback = require('../utils/backendFallback');
const { guardSnippet } = require('../utils/webviewGuard');
const path = require('path');
const { resolveLogsDir } = require('../utils/techLog');
const logSource = require('../logs/logSource');

const MAX_TAIL_LINES = logSource.MAX_TAIL_LINES;

// Feature -> technical component. The label is what the user reads in the
// component filter ("Duplication", "Audit de securite", ...), the value is the
// component marker each feature writes in its journal lines.
const FEATURES = [
  { label: 'Agent', component: 'agent' },
  { label: 'Backend', component: 'backend' },
  { label: 'Runtime', component: 'runtime' },
  { label: 'Superviseur', component: 'supervisor' },
  { label: 'Demarrage', component: 'startup' },
  { label: 'Extension', component: 'extension' },
  { label: 'Duplication', component: 'duplication' },
  { label: 'Audit de securite', component: 'secaudit' },
  { label: 'System Doctor', component: 'autofix' },
  { label: 'SDK Manager', component: 'sdk' },
  { label: 'DevOps', component: 'devops' },
  { label: 'Gestion centralisee', component: 'enterprise' },
  { label: 'Licence', component: 'license' },
  { label: 'Analyse projet', component: 'analysis' },
  { label: 'Environnement', component: 'environment' },
  { label: 'Fournisseurs', component: 'providers' },
];

function componentChoices(files) {
  const present = {};
  (files || []).forEach((f) => { present[String(f.component || '').toLowerCase()] = true; });
  const out = [{ label: 'Tous les composants', component: 'ALL', present: true }];
  FEATURES.forEach((f) => out.push({ label: f.label, component: f.component, present: !!present[f.component] }));
  // Components found on disk but not declared above (future features).
  Object.keys(present).sort().forEach((c) => {
    if (!c) return;
    if (FEATURES.some((f) => f.component === c)) return;
    out.push({ label: c, component: c, present: true, extra: true });
  });
  return out;
}

function listLogFiles(logsDir) {
  return logSource.listLogFiles(logsDir);
}

function getTail(logsDir, file, maxLines, level, opts) {
  return logSource.getTail(logsDir, file, maxLines, level, opts);
}

function lineLevel(line) {
  return logSource.lineLevel(line);
}

class LogsPanel {
  constructor(panel, extensionUri, opts) {
    this.panel = panel;
    this.disposables = [];
    this.logsDir = (opts && opts.logsDir) || resolveLogsDir({});
    this._last = { file: '', level: 'ALL', component: 'ALL', search: '', maxLines: 300, lines: [] };
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

  _filesPayload() {
    const files = listLogFiles(this.logsDir);
    return {
      type: 'files',
      dir: this.logsDir,
      files,
      components: componentChoices(files),
    };
  }

  async handleMessage(msg) {
    if (wvFallback.handlePanelMessage(null, msg)) return;
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'load' || msg.type === 'listFiles') {
        await this.panel.webview.postMessage(this._filesPayload());
        return;
      }
      if (msg.type === 'getTail') {
        const tail = getTail(this.logsDir, msg.file, msg.maxLines, msg.level, {
          component: msg.component,
          search: msg.search,
        });
        this._last = {
          file: tail.file || '',
          level: String(msg.level || 'ALL'),
          component: String(msg.component || 'ALL'),
          search: String(msg.search || ''),
          maxLines: parseInt(msg.maxLines, 10) || 300,
          lines: tail.lines || [],
        };
        await this.panel.webview.postMessage(Object.assign({ type: 'tail' }, tail));
        return;
      }
      if (msg.type === 'openFolder') {
        await vscode.commands.executeCommand('sudoStudio.openLogsFolder');
        return;
      }
      if (msg.type === 'copy') {
        // The webview has no clipboard access in this host: the panel copies
        // exactly what the user sees (filtered view), never the whole file.
        const text = Array.isArray(msg.lines) && msg.lines.length
          ? msg.lines.join('\n')
          : this._last.lines.join('\n');
        let ok = false;
        try {
          await vscode.env.clipboard.writeText(String(text).slice(0, 200000));
          ok = true;
        } catch (_) { ok = false; }
        await this.panel.webview.postMessage({ type: 'copied', ok, count: (text.match(/\n/g) || []).length + (text ? 1 : 0) });
        return;
      }
      if (msg.type === 'export') {
        const r = await this._exportView(msg);
        await this.panel.webview.postMessage({ type: 'exported', ...r });
        return;
      }
    } catch (e) {
      try { await this.panel.webview.postMessage({ type: 'errorMsg', message: String((e && e.message) || e) }); } catch (_) {}
    }
  }

  // P58-5: export the FILTERED view (what is on screen), not the raw file.
  async _exportView(msg) {
    const lines = Array.isArray(msg.lines) && msg.lines.length ? msg.lines : this._last.lines;
    const head = [
      '# Sudo Studio - vue filtree exportee (P58)',
      '# fichier: ' + this._last.file,
      '# niveau min: ' + this._last.level + ' | composant: ' + this._last.component +
        ' | recherche: ' + (this._last.search || '(aucune)') + ' | lignes: ' + lines.length,
      '# source: ' + path.join(this.logsDir, this._last.file),
      '',
    ].join('\n');
    const body = head + lines.join('\n') + '\n';
    let target = null;
    try {
      if (vscode.window.showSaveDialog) {
        const safe = String(this._last.file || 'journal').replace(/[^A-Za-z0-9_.-]+/g, '_');
        const picked = await vscode.window.showSaveDialog({
          saveLabel: 'Exporter',
          filters: { 'Journal (texte)': ['log', 'txt'] },
          defaultUri: vscode.Uri.file(path.join(this.logsDir, safe + '.vue.log')),
        });
        if (picked && picked.fsPath) target = picked.fsPath;
      }
    } catch (_) { target = null; }
    if (!target) return { ok: false, error: 'aucun chemin choisi' };
    try {
      require('fs').writeFileSync(target, body, 'utf8');
      return { ok: true, path: target, count: lines.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
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
select, button, input[type=text] { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 4px 8px; }
input[type=text] { min-width: 180px; }
button { cursor: pointer; }
button:hover { background: #30363d; }
#meta { font-size: 11px; color: #7d8590; margin-bottom: 8px; }
#out { background: #010409; border: 1px solid #21262d; border-radius: 4px; padding: 8px; height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.lv-ERROR { color: #f85149; } .lv-WARN { color: #e3b341; } .lv-INFO { color: #7d8590; }
.lv-DEBUG { color: #6e7681; } .lv-NONE { color: #c9d1d9; }
.errline { background: #2d1214; }
label { font-size: 11px; color: #7d8590; }
#msg { font-size: 11px; color: #3fb950; min-height: 14px; }
#msg.bad { color: #f85149; }
</style>
</head>
<body>
${guardSnippet()}
<h2>Technical logs</h2>
<div id="meta">loading...</div>
<div class="row">
<label for="file">File</label><select id="file" onchange="refresh()"></select>
<label for="component">Composant</label><select id="component" onchange="refresh()"></select>
<label for="level">Niveau (min)</label><select id="level" onchange="refresh()"><option>ALL</option><option>DEBUG</option><option>INFO</option><option>WARN</option><option>ERROR</option></select>
<label for="search">Recherche</label><input type="text" id="search" placeholder="texte..." oninput="onSearch()">
<label for="lines">Lignes</label><select id="lines" onchange="refresh()"><option>100</option><option selected>300</option><option>1000</option><option>2000</option></select>
<button onclick="refresh()">Refresh</button>
<label><input type="checkbox" id="auto" onchange="toggleAuto(this.checked)"> suivi auto (2s)</label>
</div>
<div class="row">
<button onclick="openFolder()">Open logs folder</button>
<button onclick="copyView()">Copier</button>
<button onclick="exportView()">Exporter la vue</button>
<span id="msg"></span>
</div>
<pre id="out"></pre>
<script>
var vscode = acquireVsCodeApi();
var timer = null;
var searchTimer = null;
var lastLines = [];
var currentFile = '';
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function levelOf(line) {
  var m = /\\[\\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\\s*\\]/.exec(line);
  if (m) return m[1] === 'WARNING' ? 'WARN' : (m[1] === 'FATAL' ? 'ERROR' : (m[1] === 'TRACE' ? 'DEBUG' : m[1]));
  var t = String(line).trim();
  if (t.charAt(0) === '{') {
    try {
      var o = JSON.parse(t);
      var lv = String(o.level || o.severity || '').toUpperCase();
      if (lv) return lv === 'WARNING' ? 'WARN' : (lv === 'FATAL' ? 'ERROR' : lv);
    } catch (e) { /* plain text */ }
  }
  return 'NONE';
}
function refresh() {
  var f = document.getElementById('file').value;
  if (!f) return;
  currentFile = f;
  vscode.postMessage({
    type: 'getTail', file: f,
    maxLines: document.getElementById('lines').value,
    level: document.getElementById('level').value,
    component: document.getElementById('component').value,
    search: document.getElementById('search').value
  });
}
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(function() { refresh(); }, 220);
}
function openFolder() { vscode.postMessage({ type: 'openFolder' }); }
function copyView() { vscode.postMessage({ type: 'copy', lines: lastLines }); }
function exportView() { vscode.postMessage({ type: 'export', lines: lastLines }); }
function toggleAuto(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(function() { refresh(); }, 2000);
}
function note(msg, bad) {
  var el = document.getElementById('msg');
  el.textContent = msg || '';
  el.className = bad ? 'bad' : '';
}
window.addEventListener('message', function(e) {
  var m = e.data || {};
  if (m.type === 'files') {
    var sel = document.getElementById('file');
    var keep = sel.value;
    sel.innerHTML = '';
    (m.files || []).forEach(function(f) {
      var o = document.createElement('option');
      o.value = f.name;
      o.textContent = f.name + ' (' + f.size + ' b)';
      sel.appendChild(o);
    });
    if (keep) {
      for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === keep) sel.value = keep;
    }
    var cs = document.getElementById('component');
    var keepC = cs.value;
    cs.innerHTML = '';
    (m.components || []).forEach(function(c) {
      var o2 = document.createElement('option');
      o2.value = c.component;
      o2.textContent = c.label + (c.present ? '' : ' (aucun journal)');
      cs.appendChild(o2);
    });
    if (keepC) cs.value = keepC;
    document.getElementById('meta').textContent = m.dir + ' (' + (m.files || []).length + ' fichiers)';
    if ((m.files || []).length) refresh();
    return;
  }
  if (m.type === 'tail') {
    var out = document.getElementById('out');
    if (m.error) { out.innerHTML = ''; note('Erreur: ' + m.error, true); return; }
    lastLines = m.lines || [];
    var html = '';
    for (var i2 = 0; i2 < lastLines.length; i2++) {
      var l = lastLines[i2];
      var lv = levelOf(l);
      html += '<span class="lv-' + lv + (lv === 'ERROR' ? ' errline' : '') + '">' + esc(l) + '</span>\\n';
    }
    out.innerHTML = html || '(aucune ligne pour ce filtre)';
    out.scrollTop = 1e9;
    document.getElementById('meta').textContent = m.file + ' | ' + lastLines.length + ' ligne(s) affichee(s) / ' +
      (m.matched || 0) + ' correspondante(s) / ' + (m.total || 0) + ' lues | ' + (m.scannedBytes || 0) +
      ' o lus en ' + (m.ms || 0) + ' ms | niveau=' + document.getElementById('level').value +
      ' composant=' + document.getElementById('component').value +
      (m.truncated ? ' | (fenetre limitee)' : '');
    note('');
  }
  if (m.type === 'copied') note(m.ok ? 'Vue copiee (' + m.count + ' lignes).' : 'Copie impossible.', !m.ok);
  if (m.type === 'exported') note(m.ok ? 'Exporte: ' + m.path + ' (' + m.count + ' lignes).' : 'Export annule: ' + (m.error || ''), !m.ok);
  if (m.type === 'errorMsg') note(m.message, true);
});
vscode.postMessage({ type: 'load' });
</script>
</body>
</html>`;
  }
}

module.exports = {
  LogsPanel, listLogFiles, getTail, lineLevel,
  componentChoices, FEATURES,
};
