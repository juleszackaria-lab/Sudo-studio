/**
 * SUDO STUDIO - PROMPT 8: agent sandbox.
 *
 * Levels (never confuse permission prompts with real sandboxing):
 *  - L1 "Mode restreint" (always on): the sudo-agent server is spawned with
 *    a filtered environment (no secrets), a restricted token attempt + Job
 *    Object on Windows (children die with the job), a process group on POSIX
 *    (tree kill on stop), and a run-level watchdog. Command allow/block
 *    lists + path containment are enforced at the permission layer (defence
 *    in depth, NOT called sandbox).
 *  - L2 "Sandbox isolee": REMOVED with the former third-party server (P27).
 *    Only L2 *detection* (detectL2/pickL2) remains, so the UI can report an
 *    honest unavailability reason. The active level is always L1.
 *
 * Every audit entry goes through the shared audit log (SANDBOX_* actions).
 * This module is pure Node (no vscode dependency) so the P8 suite can load
 * it directly. All strings are ASCII on purpose (repo gate).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let _audit = null;
try { _audit = require('../utils/auditLog'); } catch (_) { _audit = null; }
let _mask = (s) => String(s == null ? '' : s);
try { _mask = require('../utils/secretFilter').maskSecrets; } catch (_) { /* keep identity */ }

const DEFAULT_IMAGE = process.env.SUDO_SANDBOX_IMAGE || 'sudo-studio/sandbox:latest';
const RUN_TIMEOUT_DEFAULT_MS = 20 * 60 * 1000; // same ceiling as the model-call timeout

// ---------------------------------------------------------------------------
// 1. Spawn-environment filtering (secrets never reach the agent process)
// ---------------------------------------------------------------------------
// High-confidence secret-bearing variable names. Deliberately NOT matched:
//  *PROXY* (kept: model calls may need the corporate proxy; documented),
// SSH_AUTH_SOCK (kept: git-over-ssh; the socket itself holds no secret),
// AWS_REGION / AWS_PROFILE style routing variables (no secret inside).
const SECRET_KEY_RE = /(SECRET|TOKEN|BEARER|PASSWORD|PASSWD|PRIVATE_KEY|PRIVATEKEY|CREDENTIAL|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|CONNECTION_STRING|DATABASE_URL|AUTH[_-]?KEY|SIGNING_KEY)/i;

function isSecretKey(name) {
    if (name === 'PWD' || name === 'OLDPWD') return false;
    return SECRET_KEY_RE.test(String(name || ''));
}

// Returns { env, stripped } ; `stripped` holds NAMES only, never values.
function filterSpawnEnv(input) {
    const env = {};
    const stripped = [];
    const src = input || {};
    for (const k of Object.keys(src)) {
        if (isSecretKey(k)) { stripped.push(k); continue; }
        env[k] = src[k];
    }
    stripped.sort();
    return { env, stripped };
}

// ---------------------------------------------------------------------------
// 2. Command inspection (permission layer, defence in depth)
// ---------------------------------------------------------------------------
function extractCommand(perm) {
    if (!perm || typeof perm !== 'object') return '';
    if (typeof perm.pattern === 'string' && perm.pattern) return perm.pattern;
    let md = perm.metadata;
    if (typeof md === 'string') {
        try { md = JSON.parse(md); } catch (_) { return ''; }
    }
    if (md && typeof md === 'object') {
        for (const k of ['command', 'cmd', 'script', 'commandLine']) {
            if (typeof md[k] === 'string' && md[k]) return md[k];
        }
        if (Array.isArray(md.args) && md.args.length) {
            return md.args.map((a) => String(a)).join(' ');
        }
    }
    return '';
}

// Tokenizer: quoted strings + bare path-looking tokens. Understands POSIX and
// Windows spellings on any platform (cross-platform tokens fail closed).
function extractPathTokens(cmd) {
    const out = [];
    const text = String(cmd || '');
    if (!text) return out;
    const seen = new Set();
    const push = (t) => {
        if (!t || seen.has(t)) return;
        seen.add(t);
        out.push(t);
    };
    let m;
    const qre = /'([^']+)'|"([^"]+)"|`([^`]+)`/g;
    while ((m = qre.exec(text)) !== null) push(m[1] || m[2] || m[3]);
    const parts = text.split(/[\s;&|()[\]{}<>"'`]+/);
    for (let tok of parts) {
        if (!tok) continue;
        tok = tok.replace(/[.,!?)\]}]+$/, '');
        if (/^(~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|%[A-Za-z_][A-Za-z0-9_]*%|\$[{A-Za-z_])/i.test(tok)) {
            push(tok);
        }
    }
    return out;
}

const KNOWN_ENV_DIRS = ['SystemRoot', 'SystemDrive', 'USERPROFILE', 'TEMP', 'TMP',
    'HOME', 'TMPDIR', 'ProgramFiles', 'ProgramData', 'APPDATA', 'LOCALAPPDATA',
    'ALLUSERSPROFILE', 'PUBLIC', 'HOMEDRIVE', 'HOMEPATH'];

function expandKnownVars(tok) {
    let t = String(tok);
    // %NAME% (Windows) then $NAME / ${NAME} (POSIX), known directories only.
    t = t.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (mm, name) => {
        if (KNOWN_ENV_DIRS.indexOf(name) === -1) return mm;
        return process.env[name] || mm;
    });
    t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (mm, b, plain) => {
            const name = b || plain;
            if (KNOWN_ENV_DIRS.indexOf(name) === -1) return mm;
            return process.env[name] || mm;
        });
    if (t === '~' || t.indexOf('~/') === 0 || t.indexOf('~\\') === 0) {
        t = os.homedir() + t.slice(1);
    }
    return t;
}

function tokenFlavor(tok) {
    if (/^[A-Za-z]:[\\/]/.test(tok) || tok.indexOf('\\\\') === 0) return 'win32';
    return 'posix';
}

// Lexical resolve of one token against root (no fs access). Returns
// { abs, flavor } or null when the token cannot be resolved safely.
function resolveToken(root, tok, platform) {
    const plat = platform || process.platform;
    let t = expandKnownVars(tok);
    if (/[%$]/.test(t) && /%[A-Za-z_]|(final|undefined)/.test(t)) {
        // Unexpanded variable left: unresolvable -> caller fails closed.
        if (/%[A-Za-z_]/.test(t) || /\$[{A-Za-z_]/.test(t)) return null;
    }
    // Strip ADS suffix (host part still evaluated): "file.txt:ads" -> "file.txt".
    if (!/^[A-Za-z]:[\\/]/.test(t) && t.indexOf(':') !== -1) t = t.slice(0, t.indexOf(':'));
    if (!t) return null;
    const flavor = tokenFlavor(t);
    if (flavor === 'win32' && plat !== 'win32') return { abs: null, flavor, outside: true };
    if (flavor === 'posix' && plat === 'win32' && t.charAt(0) === '/') {
        // git-bash spelling on Windows: /c/x -> C:\x (best effort).
        const gm = /^\/([a-zA-Z])\//.exec(t);
        if (gm) t = gm[1] + ':\\' + t.slice(3).replace(/\//g, '\\');
        else if (t.indexOf('/') !== -1) return { abs: null, flavor, outside: true };
    }
    const mod = flavor === 'win32' ? path.win32 : path.posix;
    let abs;
    try {
        abs = mod.isAbsolute(t) ? mod.normalize(t) : mod.resolve(root, t);
    } catch (_) { return null; }
    return { abs, flavor, outside: false };
}

// Symlink-aware containment: nearest existing ancestor is realpath()ed so a
// symlink inside the project pointing outside is detected (P8 escape test).
function resolveLinks(root, abs, flavor) {
    const mod = flavor === 'win32' ? path.win32 : path.posix;
    try {
        let cur = abs;
        const rest = [];
        for (;;) {
            if (fs.existsSync(cur)) break;
            const parent = mod.dirname(cur);
            if (!parent || parent === cur) return abs;
            rest.unshift(mod.basename(cur));
            cur = parent;
        }
        const real = fs.realpathSync(cur);
        return rest.length ? mod.join(real, ...rest) : real;
    } catch (_) { return abs; }
}

function isInsideProject(root, abs, flavor) {
    const mod = flavor === 'win32' ? path.win32 : path.posix;
    let rel;
    try { rel = mod.relative(root, abs); } catch (_) { return false; }
    if (flavor === 'win32') { rel = rel.toLowerCase(); }
    return rel === '' || (rel !== '..' && rel.indexOf('..' + mod.sep) !== 0 && !mod.isAbsolute(rel));
}

// Sensitive zones: same deny as "outside project", but with an explicit
// reason so the audit row proves WHAT was protected.
function sensitiveZone(abs, flavor) {
    const t = flavor === 'win32' ? String(abs).replace(/\//g, '\\').toLowerCase()
        : String(abs);
    const home = flavor === 'win32' ? null : os.homedir();
    const has = (s) => t.indexOf(s) !== -1;
    if (flavor === 'win32') {
        const wr = (process.env.SystemRoot || 'c:\\windows').replace(/\//g, '\\').toLowerCase();
        if (t === wr || t.indexOf(wr + '\\') === 0) return 'SystemRoot (' + wr + ')';
        return null;
    }
    if (!home) return null;
    if (t === home + '/.ssh' || t.indexOf(home + '/.ssh/') === 0) return '~/.ssh';
    if (t.indexOf('/etc/ssh') === 0 || t === '/etc/shadow' || t === '/etc/gshadow') return 'system ssh/shadow';
    if (t === home + '/.gnupg' || t.indexOf(home + '/.gnupg/') === 0) return '~/.gnupg';
    if (t === home + '/.aws' || t.indexOf(home + '/.aws/') === 0) return '~/.aws';
    if (t === home + '/.kube' || t.indexOf(home + '/.kube/') === 0) return '~/.kube';
    if (t === home + '/.docker' || t.indexOf(home + '/.docker/') === 0) return '~/.docker';
    if (t === home + '/.npmrc' || t === home + '/.netrc') return 'credentials file';
    const base = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
    if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(_.*|\.pub)?$/.test(base)) return 'private key file';
    if (/\.(pem|key|pfx|p12|kdbx|asc)$/.test(base)) return 'key material file';
    if (has('/.ssh/') || has('/.gnupg/')) return 'keys directory';
    return null;
}

// -- block lists ------------------------------------------------------------
// TIER1: denied as a bare command word anywhere (audited for false positives:
// no entry matches a flag spelling or a `git init`-style subcommand).
const BLOCKED_TOOLS = ('aria2c axel ftp lftp ncftp tftp telnet rsh rlogin rexec rcp nc ncat nmap nping ' +
    'socat smbclient psexec winrs invoke-webrequest invoke-restmethod iwr bitsadmin mshta rundll32 ' +
    'regsvr32 mimikatz gsecdump ntdsutil vssadmin diskpart bcdedit bootrec format mkfs mkfs.ext4 ' +
    'mkfs.ntfs fdisk parted gdisk mount umount losetup dmsetup mkswap swapon swapoff insmod modprobe rmmod ' +
    'iptables nft firewall-cmd ufw shutdown poweroff reboot halt telinit useradd userdel usermod groupadd ' +
    'chpasswd newusers passwd su sudo doas runas crontab launchctl docker podman ctr nerdctl kubectl helm k9s ' +
    'wsl vboxmanage vmrun windowssandbox dumpcap tshark tcpdump wireshark takeown cipher regini ' +
    'bcdboot reagentc wbadmin diskshadow ntdsutil dsquery dsget adfind bloodhound sharphound rubeus').split(' ');

function toolWordRe(tool) {
    return new RegExp('(^|[\\s;&|()\\[\\]{}"\'`$=<>!+/])' + tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(\\.exe)?($|[\\s;&|()\\[\\]{}"\'`$=<>!+.,:/])', 'i');
}

// TIER2: tool word + network/danger trigger somewhere in the command.
const COMBO_RULES = [
    { re: /\bcurl(\.exe)?\b/i, trig: /(:\/\/|\s+https?:|\s+[a-z]+:\/\/|\s-O\b|\s-o\s|\s-H\b|--data|--output|--upload-file)/i, why: 'telechargement reseau (curl)' },
    { re: /\bwget(\.exe)?\b/i, trig: /(:\/\/|\s+https?:|\s+[a-z]+:\/\/|\s-O\b|\s-o\s|--output-document)/i, why: 'telechargement reseau (wget)' },
    { re: /(^|[\s;&|($`])http(\.exe)?($|[\s;&|)\]])/i, trig: /(:\/\/|\s+[a-z]+:)/i, why: 'client http en ligne de commande' },
    { re: /\bssh(\.exe)?\b/i, trig: /(@|:\/\/|\s-i\s|\s-p\s|\s-L\s|\s-R\s|\s-D\s)/, why: 'connexion distante (ssh)' },
    { re: /\bscp(\.exe)?\b/i, trig: /(@|:|:\/\/)/, why: 'copie distante (scp)' },
    { re: /\bsftp(\.exe)?\b/i, trig: /./, why: 'transfert distant (sftp)' },
    { re: /\b(python3?|py)(\.exe)?\b/i, trig: /(-c\b|--command\b).*(urllib|socket|http\.client|requests\b|httpx|aiohttp|ftplib|smtplib)/is, why: 'script inline avec acces reseau (python)' },
    { re: /\bnode(\.exe)?\b/i, trig: /(-e\b|--eval\b).*(fetch\(|https?:|require\(.http|axios|node-fetch|\bnet\b\.)/is, why: 'script inline avec acces reseau (node)' },
    { re: /\bruby(\.exe)?\b/i, trig: /(-e\b).*(net\/http|open-uri|socket)/is, why: 'script inline avec acces reseau (ruby)' },
    { re: /\bperl(\.exe)?\b/i, trig: /(-e\b|-M\b).*(LWP|IO::Socket|HTTP::)/is, why: 'script inline avec acces reseau (perl)' },
    { re: /\bphp(\.exe)?\b/i, trig: /(-r\b).*(curl|file_get_contents\s*\(\s*.http|fsockopen)/is, why: 'script inline avec acces reseau (php)' },
    { re: /\b(powershell|pwsh)(\.exe)?\b/i, trig: /(-encodedcommand\b|-\be?nc\b|frombase64|webclient|downloadstring|downloadfile|invoke-webrequest|invoke-restmethod|\biex\b|invoke-expression)/i, why: 'powershell obscurci / telechargeur' },
    { re: /\bcertutil(\.exe)?\b/i, trig: /(-urlcache|-split|\s-decode\b|\s-encode\b|\s+https?:)/i, why: 'certutil detourne (telechargement/decode)' },
    { re: /\bwevtutil(\.exe)?\b/i, trig: /(\scl\b|clear-log)/i, why: 'effacement de journaux (wevtutil)' },
    { re: /(^|[\s;&|($`])reg(\.exe)?($|[\s])/i, trig: /(\sadd\b|\sdelete\b|\simport\b|\ssave\b|\srestore\b)/i, why: 'modification du registre (reg)' },
    { re: /\bschtasks(\.exe)?\b/i, trig: /(create|delete|change|\srun\b)/i, why: 'persistance planificateur (schtasks)' },
    { re: /(^|[\s;&|($`])sc(\.exe)?($|[\s])/i, trig: /(\screate\b|\sdelete\b|\sconfig\b|\sstart\b|\sstop\b|\sfailure\b)/i, why: 'modification de service (sc)' },
    { re: /(^|[\s;&|($`])net(\.exe)?($|[\s])/i, trig: /(\suser\b|localgroup|\sshare\b|\suse\b|session|\sview\b)/i, why: 'administration reseau/comptes (net)' },
    { re: /\bcipher(\.exe)?\b/i, trig: [/\/w/i], why: 'effacement disque (cipher /w)' },
    { re: /(^|[\s;&|($`])dd(\.exe)?($|[\s])/i, trig: [/\sif=\/dev/i, /\sof=\/dev/i, /\sof=\//i], why: 'ecriture brute disque (dd)' },
    { re: /\bsysctl\b/i, trig: [/(-w\b|=)/], why: 'modification noyau (sysctl)' },
    { re: /\b(systemctl|service)\b/i, trig: [/(poweroff|reboot|halt|kexec)/i], why: 'arret / reboot machine' },
    { re: /\bchmod\b/, trig: [/-R\s+[0-7]*777\s+\//], why: 'permissions ouvertes sur racine (chmod)' },
    { re: /\bchown\b/, trig: [/-R\s+\S+\s+\//], why: 'reattribution racine (chown)' },
];

// TIER3: dangerous no matter the tool.
const DANGER_RES = [
    { re: /:\(\)\s*\{[^}]*:\s*\|\s*:&\s*\}\s*;\s*:/, why: 'fork bomb' },
    { re: />\s*\/dev\/(sd|hd|nvme|vd|xvd)[a-z]+\d*\b/, why: 'ecriture brute disque' },
    { re: /\bmkswap\b|\bswapon\b/, why: 'manipulation swap' },
];

// Recursive-delete verbs: denied only when a target resolves outside.
const RECDEL_RES = [
    { re: /\brm\s+[^\n;&|]*-[a-zA-Z]*r/i, name: 'rm -r' },
    { re: /\bdel(\.exe)?\s+([^\n;&|]*\/s)/i, name: 'del /s' },
    { re: /\b(rmdir|rd)(\.exe)?\s+([^\n;&|]*\/s)/i, name: 'rmdir /s' },
    { re: /\berase(\.exe)?\s+([^\n;&|]*\/s)/i, name: 'erase /s' },
    { re: /\bremove-item\b[^\n;&|]*-(recurse|rf|recurse:\$true)/i, name: 'Remove-Item -Recurse' },
];

function normCmd(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function coerceLists(obj) {
    const pick = (v) => (Array.isArray(v) ? v : [])
        .map((x) => String(x == null ? '' : x).trim())
        .filter((x) => x.length > 0 && x.length <= 300)
        .slice(0, 50);
    const o = obj || {};
    return { allow: pick(o.sandboxAllow), block: pick(o.sandboxBlock) };
}

function evaluateBash(cmd, opts = {}) {
    const root = opts.projectRoot || null;
    const platform = opts.platform || process.platform;
    const text = String(cmd || '');
    if (!text.trim()) return { verdict: 'ask', reason: 'commande vide ou illisible' };
    const extra = { allow: opts.extraAllow || [], block: opts.extraBlock || [] };
    const norm = normCmd(text);

    for (const entry of extra.block) {
        if (entry && norm.indexOf(normCmd(entry)) !== -1) {
            return { verdict: 'deny', reason: 'liste noire: ' + String(entry).slice(0, 80) };
        }
    }
    for (const tool of BLOCKED_TOOLS) {
        if (toolWordRe(tool).test(text)) {
            return { verdict: 'deny', reason: 'outil interdit: ' + tool };
        }
    }
    for (const rule of COMBO_RULES) {
        const trigs = Array.isArray(rule.trig) ? rule.trig : [rule.trig];
        if (rule.re.test(text) && trigs.some((t) => t.test(text))) {
            return { verdict: 'deny', reason: rule.why };
        }
    }
    for (const d of DANGER_RES) {
        if (d.re.test(text)) return { verdict: 'deny', reason: d.why };
    }
    // Pipe of a downloader straight into a shell (belt: downloader already blocked).
    if (/(curl|wget|invoke-webrequest|invoke-restmethod|bitsadmin)[^|\n]*\|\s*(sh|bash|dash|zsh|fish|powershell|pwsh|cmd)\b/i.test(text)) {
        return { verdict: 'deny', reason: 'pipe shell distant' };
    }

    if (root) {
        const tokens = extractPathTokens(text);
        // Recursive delete with an outside target.
        for (const rd of RECDEL_RES) {
            if (!rd.re.test(text)) continue;
            for (const tok of tokens) {
                if (/^\\\\/.test(tok)) {
                    return { verdict: 'deny', reason: 'destruction vers chemin reseau (' + rd.name + ')' };
                }
                const r = resolveToken(root, tok, platform);
                if (!r) continue; // unresolvable target -> human decides (ask below)
                if (r.outside || !r.abs) {
                    return { verdict: 'deny', reason: 'destruction hors projet (' + rd.name + ')' };
                }
                const real = resolveLinks(root, r.abs, r.flavor);
                if (!isInsideProject(root, real, r.flavor)) {
                    return { verdict: 'deny', reason: 'destruction hors projet (' + rd.name + ')' };
                }
            }
        }
        // General containment: every resolvable path token must stay inside.
        for (const tok of tokens) {
            if (/^\\\\[^\\]/.test(tok)) return { verdict: 'deny', reason: 'chemin reseau (UNC)' };
            const r = resolveToken(root, tok, platform);
            if (!r) continue; // unresolvable -> human decides
            if (r.outside || !r.abs) {
                return { verdict: 'deny', reason: 'chemin hors projet: ' + tok.slice(0, 60) };
            }
            const real = resolveLinks(root, r.abs, r.flavor);
            if (!isInsideProject(root, real, r.flavor)) {
                const zone = sensitiveZone(real, r.flavor);
                if (zone) return { verdict: 'deny', reason: 'acces zone sensible: ' + zone };
                if (real !== r.abs) {
                    return { verdict: 'deny', reason: 'lien symbolique hors projet: ' + tok.slice(0, 60) };
                }
                return { verdict: 'deny', reason: 'chemin hors projet: ' + tok.slice(0, 60) };
            }
            const zone = sensitiveZone(real, r.flavor);
            if (zone) return { verdict: 'deny', reason: 'acces zone sensible: ' + zone };
        }
    }

    for (const entry of extra.allow) {
        const e = normCmd(entry);
        if (!e) continue;
        if (norm === e || norm.indexOf(e + ' ') === 0 || norm.indexOf(e + ';') === 0) {
            return { verdict: 'allow', reason: 'liste blanche: ' + String(entry).slice(0, 80) };
        }
    }
    return { verdict: 'ask', reason: 'validation utilisateur requise' };
}

function evaluateEdit(paths, opts = {}) {
    const root = opts.projectRoot || null;
    const platform = opts.platform || process.platform;
    const list = Array.isArray(paths) ? paths : [];
    if (root) {
        for (const p of list) {
            const tok = String(p == null ? '' : p);
            if (/^\\\\[^\\]/.test(tok)) return { verdict: 'deny', reason: 'chemin reseau (UNC)' };
            const r = resolveToken(root, tok, platform);
            if (!r) continue;
            if (r.outside || !r.abs) {
                return { verdict: 'deny', reason: 'ecriture hors projet: ' + tok.slice(0, 60) };
            }
            const real = resolveLinks(root, r.abs, r.flavor);
            if (!isInsideProject(root, real, r.flavor)) {
                if (real !== r.abs) {
                    return { verdict: 'deny', reason: 'lien symbolique hors projet: ' + tok.slice(0, 60) };
                }
                return { verdict: 'deny', reason: 'ecriture hors projet: ' + tok.slice(0, 60) };
            }
        }
    }
    return { verdict: 'ask', reason: 'validation utilisateur requise' };
}

// ---------------------------------------------------------------------------
// 3. Level-2 availability detection (docker / Windows Sandbox)
// ---------------------------------------------------------------------------
function defaultExec(bin, args, timeoutMs) {
    try {
        const out = execFileSync(bin, args || [],
            { timeout: timeoutMs || 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout: String(out || '') };
    } catch (e) {
        return { code: typeof e.status === 'number' ? e.status : 1,
            stdout: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
}

let _detCache = {};
function resetDetectCache() { _detCache = {}; }

function detectL2(opts = {}) {
    const platform = opts.platform || process.platform;
    const image = opts.image || DEFAULT_IMAGE;
    const exec = opts.exec || defaultExec;
    const cacheKey = platform + '|' + image;
    if (!opts.noCache && _detCache[cacheKey]) return _detCache[cacheKey];
    const docker = detectDocker(exec, image);
    const wsb = detectWsb(exec, platform);
    const out = { docker, wsb, image };
    if (!opts.noCache) _detCache[cacheKey] = out;
    return out;
}

function detectDocker(exec, image) {
    let r;
    try { r = exec('docker', ['info'], 15000); }
    catch (_) { return { ok: false, reason: 'docker introuvable' }; }
    if (!r || r.code !== 0) return { ok: false, reason: 'docker indisponible (daemon injoignable?)' };
    try { r = exec('docker', ['image', 'inspect', image], 15000); }
    catch (_) { return { ok: false, reason: 'image ' + image + ' absente' }; }
    if (!r || r.code !== 0) return { ok: false, reason: 'image ' + image + ' absente' };
    return { ok: true, reason: '' };
}

function detectWsb(exec, platform) {
    if (platform !== 'win32') return { ok: false, reason: 'Windows requis' };
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    if (!fs.existsSync(path.join(sysRoot, 'System32', 'WindowsSandbox.exe'))) {
        return { ok: false, reason: 'Windows Sandbox non installe' };
    }
    let r;
    try {
        r = exec('powershell.exe',
            ['-NoProfile', '-Command',
                "(Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM).State"],
            60000);
    } catch (_) { return { ok: false, reason: 'verification impossible' }; }
    const state = String((r && r.stdout) || '').trim().toLowerCase();
    if (r && r.code === 0 && state === 'enabled') return { ok: true, reason: '' };
    return { ok: false, reason: 'fonctionnalite Windows Sandbox desactivee' };
}

// Preference: docker first (cross-platform, explicit --network none),
// then WSB. Returns { via: 'docker'|'wsb'|null, reason }.
function pickL2(det) {
    const d = det || {};
    if (d.docker && d.docker.ok) return { via: 'docker', reason: '' };
    if (d.wsb && d.wsb.ok) return { via: 'wsb', reason: '' };
    const r = (d.docker && d.docker.reason) || 'docker indisponible';
    const r2 = (d.wsb && d.wsb.reason) || '';
    return { via: null, reason: r + (r2 ? ' ; ' + r2 : '') };
}

// ---------------------------------------------------------------------------
// 4. Level-2 guest builders: REMOVED with the former server (P27).
// The docker/WSB/firewall/wrapper builders launched the deleted server and are gone.
// L2 *detection* (detectL2/pickL2) stays: it feeds the honest unavailability reason.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Windows L1 launcher (Job Object + restricted-token attempt)
// ---------------------------------------------------------------------------
// The launcher holds the ONLY job handle and waits for the child: killing the
// launcher closes the job, and KILL_ON_JOB_CLOSE kills the whole tree even on
// host crash. With -TokenLow the child is started through runas /trustlevel
// (de-escalation, works for standard users) and re-attached to the job by
// StartTime matching. Any failure falls back to a plain spawn and is
// reported honestly (token/job flags + note) instead of being faked.
function buildJobLauncherPs1() {
    const L = [
        "param([string]$Exe, [string]$WorkDir, [string]$Wrapper, [string]$ResultFile, [switch]$TokenLow)",
        "$ErrorActionPreference = 'Stop'",
        "$result = @{ pid = 0; job = $false; token = $false; note = '' }",
        "function Write-Result {",
        "  try { $result | ConvertTo-Json -Compress | Out-File -FilePath $ResultFile -Encoding ascii -Force } catch {}",
        "}",
        "try {",
        "  $jobCode = @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class SudoJob {",
        "  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)]",
        "  public static extern IntPtr CreateJobObject(IntPtr a, string n);",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern bool SetInformationJobObject(IntPtr h, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int l);",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern IntPtr OpenProcess(int a, bool b, int c);",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern bool CloseHandle(IntPtr h);",
        "  [StructLayout(LayoutKind.Sequential)]",
        "  public struct IO_COUNTERS {",
        "    public UInt64 ReadOperationCount; public UInt64 WriteOperationCount;",
        "    public UInt64 OtherOperationCount; public UInt64 ReadTransferCount;",
        "    public UInt64 WriteTransferCount; public UInt64 OtherTransferCount;",
        "  }",
        "  [StructLayout(LayoutKind.Sequential)]",
        "  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {",
        "    public Int64 PerProcessUserTimeLimit; public Int64 PerJobUserTimeLimit;",
        "    public UInt32 LimitFlags; public UInt32 MinimumWorkingSetSize;",
        "    public UInt32 MaximumWorkingSetSize; public UInt32 ActiveProcessLimit;",
        "    public UIntPtr Affinity; public UInt32 PriorityClass; public UInt32 SchedulingClass;",
        "  }",
        "  [StructLayout(LayoutKind.Sequential)]",
        "  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {",
        "    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;",
        "    public IO_COUNTERS IoInfo;",
        "    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;",
        "  }",
        "}",
        "'@",
        "  $haveJob = $false",
        "  try { Add-Type -TypeDefinition $jobCode -ErrorAction Stop } catch { $result.note = 'addtype-fail' }",
        "  $job = [IntPtr]::Zero",
        "  try {",
        "    $job = [SudoJob]::CreateJobObject([IntPtr]::Zero, $null)",
        "    $info = New-Object SudoJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
        "    $info.BasicLimitInformation.LimitFlags = 0x2000",
        "    $sz = [Runtime.InteropServices.Marshal]::SizeOf($info)",
        "    if ([SudoJob]::SetInformationJobObject($job, 9, [ref]$info, $sz)) { $haveJob = $true } else { $result.note = 'jobflag-fail' }",
        "  } catch { $result.note = 'job-fail' }",
        "  $result.job = $haveJob",
        "  function Add-ToJob {",
        "    param($ProcessId)",
        "    if ($job -eq [IntPtr]::Zero) { return $false }",
        "    try {",
        "      $h = [SudoJob]::OpenProcess(0x1F0FFF, $false, $ProcessId)",
        "      if ($h -eq [IntPtr]::Zero) { return $false }",
        "      $ok = [SudoJob]::AssignProcessToJobObject($job, $h)",
        "      [void][SudoJob]::CloseHandle($h)",
        "      return $ok",
        "    } catch { return $false }",
        "  }",
        "  $exeName = [IO.Path]::GetFileNameWithoutExtension($Exe)",
        "  if ($TokenLow) {",
        "    try {",
        "      $t0 = Get-Date",
        "      $psi = New-Object Diagnostics.ProcessStartInfo",
        "      $psi.FileName = 'runas.exe'",
        "      $psi.Arguments = '/trustlevel:0x20000 \"' + $Wrapper + '\"'",
        "      $psi.UseShellExecute = $false",
        "      $psi.CreateNoWindow = $true",
        "      $psi.WorkingDirectory = $WorkDir",
        "      $stub = [Diagnostics.Process]::Start($psi)",
        "      $found = 0",
        "      for ($i = 0; $i -lt 100 -and -not $found; $i++) {",
        "        Start-Sleep -Milliseconds 100",
        "        $cands = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -ge $t0 } catch { $false } } | Sort-Object StartTime -Descending)",
        "        if ($cands.Count -gt 0) { $found = $cands[0].Id }",
        "      }",
        "      if ($found) {",
        "        $result.token = $true",
        "        $result.pid = $found",
        "        if ($haveJob -and -not (Add-ToJob $found)) { $result.job = $false; $result.note = 'attach-fail' }",
        "      } else {",
        "        $result.note = 'runas-fail'",
        "        try { $stub.Kill() } catch {}",
        "      }",
        "    } catch { $result.note = 'runas-fail' }",
        "  }",
        "  if (-not $result.pid) {",
        "    $psi2 = New-Object Diagnostics.ProcessStartInfo",
        "    $psi2.FileName = $Exe",
        "    $psi2.Arguments = 'serve --pure --port ' + $env:SUDO_SANDBOX_PORT + ' --hostname 127.0.0.1'",
        "    $psi2.UseShellExecute = $false",
        "    $psi2.CreateNoWindow = $true",
        "    $psi2.WorkingDirectory = $WorkDir",
        "    $child = [Diagnostics.Process]::Start($psi2)",
        "    $result.pid = $child.Id",
        "    if ($haveJob -and -not (Add-ToJob $child.Id)) { $result.job = $false; $result.note = 'attach-fail' }",
        "  }",
        "  Write-Result",
        "  try { $wp = Get-Process -Id $result.pid -ErrorAction Stop; $wp.WaitForExit() } catch {}",
        "} catch {",
        "  $result.note = 'launcher-fail'",
        "  Write-Result",
        "}",
    ];
    return L.join('\r\n') + '\r\n';
}

// runas /trustlevel probe (cached): supported = exit 0. For admin users the
// whoami output also verifies the admin SID is gone (verified=true); for
// standard users the mechanism is applied but not distinguishable.
function runasProbe(opts = {}) {
    const key = 'runas';
    if (!opts.noCache && _detCache[key]) return _detCache[key];
    const out = { supported: false, verified: false };
    if ((opts.platform || process.platform) !== 'win32') {
        if (!opts.noCache) _detCache[key] = out;
        return out;
    }
    const exec = opts.exec || defaultExec;
    try {
        const r = exec('runas', ['/trustlevel:0x20000', 'cmd /c whoami /groups'], 20000);
        if (r && r.code === 0) {
            out.supported = true;
            const t = String(r.stdout || '');
            if (/S-1-5-32-544/i.test(t)) {
                out.verified = /deny-only|denied/i.test(t);
            } else {
                out.verified = false;
            }
        }
    } catch (_) { /* unsupported */ }
    if (!opts.noCache) _detCache[key] = out;
    return out;
}

// ---------------------------------------------------------------------------
// 6. Audit (every decision + every executed command)
// ---------------------------------------------------------------------------
function short(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '...' : t;
}

// secretFilter.maskSecrets returns {text, masked}: unwrap to plain text.
function maskedText(s) {
    try {
        const r = _mask(String(s == null ? '' : s));
        if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
        return String(r == null ? '' : r);
    } catch (_) { return String(s == null ? '' : s); }
}

function auditPerm(o = {}) {
    if (!_audit) return false;
    const tool = String(o.tool || '?');
    const verdict = String(o.verdict || '?');
    const reason = String(o.reason || '');
    const cmd = short(maskedText(o.command || ''), 200);
    const detail = tool + ' ' + verdict + ' :: ' + reason + (cmd ? ' :: ' + cmd : '');
    try {
        return _audit.appendAudit('SANDBOX_PERM', detail,
            { actor: o.actor || 'sandbox', result: verdict === 'deny' ? 'deny' : 'ok' });
    } catch (_) { return false; }
}

// Defensive extraction of one executed tool call (part shapes vary;
// unknown fields stay '?' and are never fabricated).
function extractToolExec(part) {
    const out = { tool: '?', command: '', status: '?', exitCode: null, timeMs: null };
    if (!part || typeof part !== 'object') return out;
    out.tool = String(part.tool || part.name || part.type || '?');
    const st = (part.state && typeof part.state === 'object') ? part.state : {};
    const inp = st.input != null ? st.input : part.input;
    if (typeof inp === 'string') out.command = inp;
    else if (inp && typeof inp === 'object') {
        for (const k of ['command', 'cmd', 'script', 'commandLine']) {
            if (typeof inp[k] === 'string' && inp[k]) { out.command = inp[k]; break; }
        }
        if (!out.command && Array.isArray(inp.args)) {
            out.command = inp.args.map((a) => String(a)).join(' ');
        }
    }
    out.status = String(st.status || part.status || '?');
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    out.exitCode = num(st.exitCode) != null ? num(st.exitCode)
        : num(st.code) != null ? num(st.code)
        : num(st.exit_code) != null ? num(st.exit_code)
        : (part.output && typeof part.output === 'object' ? num(part.output.exitCode) : null);
    if (st.time && typeof st.time === 'object') {
        const a = num(st.time.start), b = num(st.time.end);
        if (a != null && b != null && b >= a) out.timeMs = b - a;
    } else if (st.start != null || st.end != null) {
        const a = num(st.start), b = num(st.end);
        if (a != null && b != null && b >= a) out.timeMs = b - a;
    }
    return out;
}

function auditExec(o = {}) {
    if (!_audit) return false;
    const bits = [String(o.tool || '?'), String(o.status || '?')];
    if (o.exitCode != null) bits.push('code=' + o.exitCode);
    if (o.timeMs != null) bits.push(Math.round(o.timeMs) + 'ms');
    else if (o.observedAtMs != null) bits.push('observed@' + Math.round(o.observedAtMs) + 'ms');
    const cmd = short(maskedText(o.command || ''), 200);
    const detail = bits.join(' ') + (cmd ? ' :: ' + cmd : '');
    try {
        return _audit.appendAudit('SANDBOX_EXEC', detail,
            { actor: 'sandbox', result: String(o.status || '?') === 'error' ? 'error' : 'ok' });
    } catch (_) { return false; }
}

function auditTimeout(o = {}) {
    if (!_audit) return false;
    try {
        return _audit.appendAudit('SANDBOX_TIMEOUT',
            'delai maximal depasse (' + String(o.afterMs || '?') + 'ms)',
            { actor: 'sandbox', result: 'timeout' });
    } catch (_) { return false; }
}

module.exports = {
    DEFAULT_IMAGE,
    RUN_TIMEOUT_DEFAULT_MS,
    SECRET_KEY_RE,
    isSecretKey,
    filterSpawnEnv,
    extractCommand,
    extractPathTokens,
    expandKnownVars,
    resolveToken,
    resolveLinks,
    isInsideProject,
    sensitiveZone,
    BLOCKED_TOOLS,
    COMBO_RULES,
    DANGER_RES,
    RECDEL_RES,
    coerceLists,
    evaluateBash,
    evaluateEdit,
    defaultExec,
    resetDetectCache,
    detectL2,
    detectDocker,
    detectWsb,
    pickL2,
    buildJobLauncherPs1,
    runasProbe,
    auditPerm,
    auditExec,
    auditTimeout,
    extractToolExec,
};