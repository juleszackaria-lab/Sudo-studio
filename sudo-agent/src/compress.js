// Sudo Agent context compression (P26-c). When the budget passes 75% of
// the context size, old exchanges are summarized by the model itself: the
// summary must keep decisions, modified files and ongoing errors. Stdlib
// only, ASCII only.
'use strict';

function summarizePrompt() {
  return [
    'Summarize this agent session for continuation. Keep, concisely:',
    '1. the current goal, 2. decisions taken, 3. MODIFIED FILES (exact paths',
    'and what changed), 4. ongoing errors with their last message.',
    'Drop chit-chat and superseded attempts. Answer with the summary only.',
  ].join('\n');
}

// Replace old history with [summary-marker, ...kept-tail].
function spliceHistory(summary, messages, keepTail) {
  keepTail = keepTail == null ? 4 : keepTail;
  const tail = (messages || []).slice(-keepTail);
  const head = { role: 'system', content: '[Resume auto de la session (compression contexte)]:\n' + String(summary || '').slice(0, 4000) };
  return [head].concat(tail);
}

module.exports = { summarizePrompt, spliceHistory };
