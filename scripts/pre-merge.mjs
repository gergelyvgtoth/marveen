#!/usr/bin/env node
/**
 * Pre-merge suite: runs all 3 validators in sequence.
 *   1. fork-diff    -- what local-only symbols must be preserved
 *   2. behavior-gate -- behavior changes without test coverage
 *   3. merge-check  -- conflict markers, dup exports, dropped imports, tsc, vitest
 *
 * Exit: non-zero only if merge-check fails (hard errors).
 * fork-diff and behavior-gate are informational (exit 0 always here).
 */

import { spawnSync } from 'child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BOLD = '\x1b[1m'; const RESET = '\x1b[0m'; const DIM = '\x1b[2m';

function section(n, title) {
  console.log(`\n${BOLD}${'═'.repeat(60)}${RESET}`);
  console.log(`${BOLD} ${n}  ${title}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(60)}${RESET}\n`);
}

function run(script) {
  return spawnSync('node', [`scripts/${script}`], { cwd: ROOT, stdio: 'inherit' });
}

section('①', 'Fork divergence manifest  (npm run fork-diff)');
run('fork-diff.mjs');

section('②', 'Behavior-without-test gate  (npm run behavior-gate)');
run('behavior-gate.mjs');

section('③', 'Merge-resolution validator  (npm run merge-check)');
const result = run('merge-check.mjs');

console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
if (result.status !== 0) {
  console.error(`${BOLD}\x1b[31m✗ PRE-MERGE FAILED\x1b[0m${RESET}  Fix merge-check errors before committing.`);
  process.exit(1);
} else {
  console.log(`${BOLD}\x1b[32m✓ PRE-MERGE PASSED\x1b[0m${RESET}  Safe to commit.`);
}
