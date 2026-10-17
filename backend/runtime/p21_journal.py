"""PROMPT 21 uniform structured journal for the Python runtime.

Same line shape as the Node techLog (human file + JSON twin, secret-masked,
correlation id, session header, 10 x 10 MB rotation via RotatingFileHandler):

  2026-10-17T14:23:01+0200 [INFO] [runtime] [req-a1b2c3d4] message

Shared by server.py and server.enterprise.py. Stdlib only. install() is
idempotent and never raises (journal must never break the runtime).
"""
import json
import logging
import logging.handlers
import os
import re
import sys
import uuid

FORMAT_VERSION = 1
MAX_BYTES = 10 * 1024 * 1024
BACKUP_COUNT = 9  # current + 9 rotated = 10 files per component

_SECRET_RES = [
    (re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----', re.S),
     '[REDACTED-PRIVATE-KEY]'),
    (re.compile(r'([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\s:@]+:[^/\s@]+)@'), r'\1[REDACTED]@'),
    (re.compile(r'\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gsk_[A-Za-z0-9]{8,}|'
                r'xox[bpas]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|'
                r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]{10,})?)\b'),
     '[REDACTED]'),
    (re.compile(r'((?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|'
                r'access[_-]?token|client[_-]?secret)["\']?\s*[:=]\s*["\']?)([^"\'\s,}]+)', re.I),
     r'\1[REDACTED]'),
    (re.compile(r'([Bb]earer\s+)([A-Za-z0-9._~+/-]+=*)'), r'\1[REDACTED]'),
]


def mask(s):
    try:
        s = s if isinstance(s, str) else str(s)
    except Exception:
        return '?'
    for rx, rep in _SECRET_RES:
        try:
            s = rx.sub(rep, s)
        except Exception:
            pass
    return s


def resolve_logs_dir():
    ov = os.environ.get('SUDO_STUDIO_LOGS')
    if ov:
        return ov
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
        return os.path.join(base, 'SudoStudio', 'logs')
    return os.path.join(os.path.expanduser('~'), '.sudo_studio', 'logs')


class _P21Filter(logging.Filter):
    def filter(self, record):
        try:
            corr = getattr(record, 'p21corr', None) or '-'
            if corr == '-':
                try:
                    from flask import g as _g
                    corr = getattr(_g, 'corr', None) or '-'
                except Exception:
                    pass
            record.p21corr = corr
            if isinstance(record.msg, str):
                record.msg = mask(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {k: (mask(v) if isinstance(v, str) else v) for k, v in record.args.items()}
                else:
                    try:
                        record.args = tuple((mask(a) if isinstance(a, str) else a) for a in record.args)
                    except Exception:
                        pass
        except Exception:
            pass
        return True


class _JsonFormatter(logging.Formatter):
    def format(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            msg = '?'
        payload = {
            'v': FORMAT_VERSION,
            'ts': self.formatTime(record, '%Y-%m-%dT%H:%M:%S%z'),
            'level': (record.levelname or 'INFO').lower(),
            'component': 'runtime',
            'corr': getattr(record, 'p21corr', None) or None,
            'msg': msg,
            'fields': {},
        }
        try:
            return json.dumps(payload)
        except Exception:
            return '{"v":1,"msg":"?"}'


_installed = False


def install():
    """Attach the uniform format + masked file journals. Never raises."""
    global _installed
    if _installed:
        return True
    _installed = True
    try:
        factory = logging.getLogRecordFactory()

        def _factory(*a, **k):
            rec = factory(*a, **k)
            if not hasattr(rec, 'p21corr'):
                rec.p21corr = '-'
            return rec

        logging.setLogRecordFactory(_factory)
    except Exception:
        pass
    human_fmt = logging.Formatter(
        '%(asctime)s [%(levelname)s] [runtime] [%(p21corr)s] %(message)s',
        datefmt='%Y-%m-%dT%H:%M:%S%z')
    filt = _P21Filter()
    try:
        root = logging.getLogger()
        for h in list(root.handlers):
            try:
                h.setFormatter(human_fmt)
                h.addFilter(filt)
            except Exception:
                pass
        logs_dir = resolve_logs_dir()
        try:
            os.makedirs(logs_dir, exist_ok=True)
        except Exception:
            return True  # console only
        try:
            fh = logging.handlers.RotatingFileHandler(
                os.path.join(logs_dir, 'runtime.log'), maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT,
                encoding='utf-8')
            fh.setFormatter(human_fmt)
            fh.addFilter(filt)
            root.addHandler(fh)
        except Exception:
            pass
        try:
            jh = logging.handlers.RotatingFileHandler(
                os.path.join(logs_dir, 'runtime.jsonl'), maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT,
                encoding='utf-8')
            jh.setFormatter(_JsonFormatter())
            jh.addFilter(filt)
            root.addHandler(jh)
        except Exception:
            pass
    except Exception:
        pass
    return True


def before_request_corr():
    """Flask before_request hook: one correlation id per request."""
    try:
        from flask import g as _g, request as _rq
        h = _rq.headers.get('X-Correlation-Id') or _rq.headers.get('X-Request-Id') or ''
        if re.match(r'^[A-Za-z0-9_-]{1,64}$', h or ''):
            _g.corr = h
        else:
            _g.corr = 'req-' + uuid.uuid4().hex[:8]
    except Exception:
        pass


def session_header(logger, info):
    """Append the P21-b session banner (never truncates). Never raises."""
    try:
        info = info or {}
        logger.info('# === session start ===')
        logger.info('# build: %s | python: %s | os: %s',
                    mask(info.get('build', 'unknown')), mask(info.get('python', '?')), mask(info.get('os', '?')))
        logger.info('# cpu: %s | llamacpp: %s',
                    mask(info.get('cpu', '?')), mask(info.get('llamacpp', 'unknown')))
        logger.info('# ramMB: total=%s free=%s | model: %s',
                    mask(info.get('ramTotalMB', '?')), mask(info.get('ramFreeMB', '?')), mask(info.get('model', '?')))
        logger.info('# ports: %s | policies: %s',
                    mask(info.get('ports', '?')), mask(info.get('policies', '?')))
    except Exception:
        pass


def collect_facts(extra):
    """Best-effort session facts dict. Never raises."""
    facts = {}
    try:
        facts['python'] = sys.version.split(' ')[0]
    except Exception:
        facts['python'] = '?'
    try:
        facts['os'] = '%s %s' % (sys.platform, os.name)
    except Exception:
        facts['os'] = '?'
    try:
        facts['cpu'] = '%dx' % (os.cpu_count() or 0)
    except Exception:
        facts['cpu'] = '?'
    try:
        facts['llamacpp'] = os.environ.get('SUDO_LLAMACPP_VARIANT', 'unknown')
    except Exception:
        facts['llamacpp'] = 'unknown'
    for k in ('build', 'ramTotalMB', 'ramFreeMB', 'model', 'ports', 'policies'):
        try:
            facts[k] = (extra or {}).get(k, '?')
        except Exception:
            facts[k] = '?'
    return facts
