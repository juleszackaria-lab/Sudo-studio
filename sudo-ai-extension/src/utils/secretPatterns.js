/** SUDO STUDIO - Shared secret patterns (extracted from SecurityPanel).
 * Used by the workspace scanner AND the cloud pre-send filter.
 * ASCII-only. */
'use strict';

const SECRET_PATTERNS = [
    { label: 'AWS Access Key',        re: /AKIA[0-9A-Z]{16}/ },
    { label: 'AWS Secret Key',        re: /aws.{0,20}secret.{0,20}['"][0-9a-zA-Z\/+]{40}['"]/i },
    { label: 'Generic API Key',       re: /(api[_\-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i },
    { label: 'Private Key (PEM)',     re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { label: 'GitHub Token',          re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
    { label: 'Bearer Token',          re: /bearer\s+[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/i },
    { label: 'Database Password',     re: /(db_pass|database_password|mysql_pass|pg_pass)\s*[:=]\s*['"][^'"]{6,}['"]/i },
    { label: 'Slack Webhook',         re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/ },
    { label: 'Stripe Key',            re: /(?:r|s)k_(live|test)_[0-9a-zA-Z]{24,}/ },
    { label: 'Google API Key',        re: /AIza[0-9A-Za-z\-_]{35}/ },
    { label: 'Slack Token',           re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
    { label: 'PyPI Token',            re: /pypi-[A-Za-z0-9_-]{20,}/ },
    { label: 'NPM Token',             re: /_authToken\s*=\s*[^\s'"]+/ },
];

module.exports = SECRET_PATTERNS;
