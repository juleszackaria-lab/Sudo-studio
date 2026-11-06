// Sudo Agent OS keyring (P50-1). Windows Credential Manager through
// powershell + Advapi32 P/Invoke. Stdlib only, ASCII only, zero new
// dependency. Secrets travel inside the child STDIN pipe (base64) and
// back over STDOUT: never argv (visible in process lists), never files,
// never the journal (callers log the TARGET name at most).
//
// Targets look like 'SudoStudio/mcp/<server>'.
//
// P57-5: on a non-Windows host (or when the operator wants their own secret
// store) an INTERCHANGEABLE credential helper can be configured with
// SUDO_AGENT_KEYRING_HELPER = path to a local executable, same contract as
// the git credential helpers:
//     <helper> get <target>   -> the secret on stdout, exit 0
//     <helper> set <target>   -> the secret arrives on STDIN, exit 0
//     <helper> delete <target>
// The helper is opt-in, local only, and its stdout is NEVER logged. Without
// helper and without Windows the keyring reports keyring_unavailable (clear
// error, no silent fallback).
'use strict';

const childProcess = require('child_process');

let runner = null; // test seam: setKeyringRunner(async (script) => {code, stdout, stderr})
function setKeyringRunner(fn) { runner = typeof fn === 'function' ? fn : null; }

function validTarget(t) {
  return typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,120}$/.test(t);
}

function helperPath() {
  const p = process.env.SUDO_AGENT_KEYRING_HELPER;
  if (!p) return null;
  try {
    const st = require('fs').statSync(p);
    return st.isFile() ? p : null;
  } catch (_) { return null; }
}

function runHelper(op, target, secret) {
  return new Promise((resolve) => {
    const hp = helperPath();
    if (!hp) { resolve({ code: -1, stdout: '', stderr: 'no helper' }); return; }
    const childProcess = require('child_process');
    let child = null;
    let out = '';
    try {
      child = childProcess.spawn(hp, [op, String(target)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    } catch (e) { resolve({ code: -1, stdout: '', stderr: 'helper spawn' }); return; }
    child.stdout.on('data', (c) => { if (out.length < 4096) out += c.toString('utf8'); });
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'helper error' }));
    child.on('exit', (code) => resolve({ code: code === null ? -1 : code, stdout: out.trim(), stderr: '' }));
    try {
      if (op === 'set' && secret) child.stdin.write(String(secret));
      child.stdin.end();
    } catch (_) { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
  });
}

function available() {
  if (runner) return { ok: true, via: 'seam' };
  if (helperPath()) return { ok: true, via: 'helper' };
  if (process.platform !== 'win32') return { ok: false, code: 'keyring_unavailable', error: 'trousseau indisponible hors Windows.' };
  return { ok: true, via: 'credman' };
}

// One embedded C# P/Invoke block shared by all three operations.
function preamble() {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type @\"",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public struct CRED {',
    ' public int Flags; public int Type;',
    ' [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;',
    ' [MarshalAs(UnmanagedType.LPWStr)] public string Comment;',
    ' public long LastWritten; public int CredSize; public IntPtr CredBlob;',
    ' public int Persist; public int AttrCount; public IntPtr Attribs;',
    ' [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;',
    ' [MarshalAs(UnmanagedType.LPWStr)] public string UserName;',
    '}',
    'public class CredMan {',
    ' [DllImport("Advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="CredReadW")]',
    ' public static extern bool Read(string t,int y,int f,out IntPtr c);',
    ' [DllImport("Advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="CredWriteW")]',
    ' public static extern bool Write(ref CRED c,int f);',
    ' [DllImport("Advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="CredDeleteW")]',
    ' public static extern bool Delete(string t,int y,int f);',
    ' [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr c);',
    '}',
    '"@',
  ].join('\r\n');
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function scriptFor(op, target, secretB64) {
  const t = psQuote(target);
  const head = preamble() + '\r\n$T=' + t + ';';
  if (op === 'set') {
    return head + [
      "$B=[Convert]::FromBase64String(" + psQuote(secretB64) + ');',
      '$C=New-Object CRED;',
      '$C.Flags=0;$C.Type=1;$C.TargetName=$T;$C.Comment="Sudo Studio";',
      '$C.CredSize=$B.Length;',
      '$C.CredBlob=[Runtime.InteropServices.Marshal]::AllocCoTaskMem($B.Length);',
      '[Runtime.InteropServices.Marshal]::Copy($B,0,$C.CredBlob,$B.Length);',
      '$C.Persist=2;$C.AttrCount=0;$C.UserName="sudo-studio";',
      'if(-not [CredMan]::Write([ref]$C,0)){throw "CredWrite:"+[Runtime.InteropServices.Marshal]::GetLastWin32Error()}',
      '[Runtime.InteropServices.Marshal]::FreeCoTaskMem($C.CredBlob);',
      'Write-Output "OK";',
    ].join('\r\n');
  }
  if (op === 'get') {
    return head + [
      '$P=[IntPtr]::Zero;',
      'if(-not [CredMan]::Read($T,1,0,[ref]$P)){throw "NOTFOUND:"+[Runtime.InteropServices.Marshal]::GetLastWin32Error()}',
      '$C=[Runtime.InteropServices.Marshal]::PtrToStructure($P,[type][CRED]);',
      '$B=New-Object byte[] $C.CredSize;',
      '[Runtime.InteropServices.Marshal]::Copy($C.CredBlob,$B,0,$C.CredSize);',
      '[CredMan]::CredFree($P);',
      '[Console]::Write([Text.Encoding]::UTF8.GetString($B));',
    ].join('\r\n');
  }
  return head + [
    'if(-not [CredMan]::Delete($T,1,0)){$E=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($E -ne 1168){throw "CredDelete:"+$E}}',
    'Write-Output "OK";',
  ];
}

function runReal(script, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr: String(stderr).slice(0, 500) });
    };
    let child = null;
    try {
      child = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e).slice(0, 200) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(124); }, timeoutMs || 15000);
    child.stdout.on('data', (d) => { stdout += String(d || ''); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on('data', (d) => { stderr += String(d || ''); });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === null ? -1 : code); });
    try {
      child.stdin.write(script, 'utf8');
      child.stdin.end();
    } catch (_) { finish(-1); }
  });
}

async function runPs(script, timeoutMs) {
  if (runner) {
    try { return await runner(script); }
    catch (e) { return { code: -1, stdout: '', stderr: String((e && e.message) || e).slice(0, 200) }; }
  }
  return runReal(script, timeoutMs);
}

async function setSecret(target, secret, opts) {
  if (!validTarget(target)) return { ok: false, code: 'bad_args', error: 'cible trousseau invalide.' };
  if (typeof secret !== 'string' || !secret) return { ok: false, code: 'bad_args', error: 'secret vide refuse.' };
  if (secret.length > 10000) return { ok: false, code: 'too_big', error: 'secret trop long (10 000 max).' };
  const av = available();
  if (!av.ok) return av;
  if (av.via === 'helper') {
    const rh = await runHelper('set', target, secret);
    if (rh.code === 0) return { ok: true, target, via: 'helper' };
    return { ok: false, code: 'keyring_error', error: 'ecriture via assistant impossible (' + target + ').' };
  }
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  const r = await runPs(scriptFor('set', target, b64), opts && opts.timeoutMs);
  if (r.code === 0 && String(r.stdout).indexOf('OK') !== -1) return { ok: true, target };
  return { ok: false, code: 'keyring_error', error: 'ecriture trousseau impossible (' + target + ').' };
}

async function getSecret(target, opts) {
  if (!validTarget(target)) return { ok: false, code: 'bad_args', error: 'cible trousseau invalide.' };
  const av = available();
  if (!av.ok) return av;
  if (av.via === 'helper') {
    const r = await runHelper('get', target);
    // Le secret ne sort JAMAIS d'ici : pas de journal, pas d'erreur detaillee.
    if (r.code === 0 && r.stdout) return { ok: true, target, secret: r.stdout, via: 'helper' };
    return { ok: false, code: 'not_found', error: 'aucun secret pour ' + target + '.' };
  }
  const r = await runPs(scriptFor('get', target), opts && opts.timeoutMs);
  if (r.code === 0) return { ok: true, target, secret: String(r.stdout || '') };
  if (String(r.stderr).indexOf('NOTFOUND') !== -1) return { ok: false, code: 'not_found', error: 'aucun secret pour ' + target + '.' };
  return { ok: false, code: 'keyring_error', error: 'lecture trousseau impossible (' + target + ').' };
}

async function deleteSecret(target, opts) {
  if (!validTarget(target)) return { ok: false, code: 'bad_args', error: 'cible trousseau invalide.' };
  const av = available();
  if (!av.ok) return av;
  if (av.via === 'helper') {
    const rd = await runHelper('delete', target);
    return rd.code === 0 ? { ok: true, target, via: 'helper' }
      : { ok: false, code: 'keyring_error', error: 'suppression via assistant impossible (' + target + ').' };
  }
  const r = await runPs(scriptFor('delete', target), opts && opts.timeoutMs);
  if (r.code === 0) return { ok: true, target };
  return { ok: false, code: 'keyring_error', error: 'suppression trousseau impossible (' + target + ').' };
}

module.exports = { available, setSecret, getSecret, deleteSecret, setKeyringRunner, validTarget, helperPath };
