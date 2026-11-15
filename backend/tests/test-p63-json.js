/**
 * SUDO STUDIO - P63-F (G4) : enveloppe node du test python.
 *
 * Le code teste (repair_tool_output) est du Python : on lance le VRAI script
 * backend/tests/test_p63_json.py et on propage son code de sortie. Aucun
 * resultat n'est simule ici : si python est absent ou si un cas echoue, la
 * suite echoue.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'test_p63_json.py');
const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];

let last = null;
for (const exe of candidates) {
  const r = spawnSync(exe, [script], { stdio: 'inherit' });
  last = r;
  if (r.error && r.error.code === 'ENOENT') continue;
  process.exit(r.status === null ? 1 : r.status);
}
console.log('FAIL - aucun interpreteur python trouve (' + candidates.join(', ') + ')');
process.exit(1);
