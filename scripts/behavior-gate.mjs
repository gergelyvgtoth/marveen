#!/usr/bin/env node
/**
 * Behavior-change-without-test gate.
 * Finds changed source files (non-test) whose exported/public symbols lack
 * any corresponding test coverage. Warns but does not block (exit 0 unless --strict).
 *
 * Usage:
 *   node scripts/behavior-gate.mjs [--staged] [--since HEAD~1] [--strict]
 *
 *   --staged      check only staged changes (default: HEAD~1..HEAD)
 *   --since <ref> compare against this ref instead of HEAD~1
 *   --strict      exit non-zero if any uncovered changes found
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ANSI = {
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
  cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m'
};

const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const strict = argv.includes('--strict');
const sinceIdx = argv.indexOf('--since');
const sinceRef = sinceIdx >= 0 ? argv[sinceIdx + 1] : 'HEAD~1';

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '').trim();
  }
}

// ─── Get changed files ────────────────────────────────────────────────────────
let rawDiff;
if (staged) {
  rawDiff = run('git diff --cached --name-only');
} else {
  rawDiff = run(`git diff ${sinceRef}..HEAD --name-only`);
}

const changedFiles = rawDiff.split('\n').filter(Boolean);

const sourceFiles = changedFiles.filter(f =>
  /\.(ts|tsx)$/.test(f) &&
  !f.includes('__tests__') &&
  !f.includes('.test.') &&
  !f.includes('.spec.') &&
  !f.includes('node_modules') &&
  !f.endsWith('.d.ts')
);

const testFiles = changedFiles.filter(f =>
  f.includes('__tests__') || f.includes('.test.') || f.includes('.spec.')
);

// ─── Extract changed symbols from a diff ─────────────────────────────────────
// Matches added lines (+) that declare an exported or public function/class/method
const ADDED_EXPORT = /^\+\s*export\s+(?:(?:async|default)\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
// Non-exported functions/methods that changed (class methods, plain functions)
const ADDED_FUNC = /^\+\s*(?:(?:public|private|protected|static|async|override)\s+)*(?:function\*?\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const REMOVED_LINE = /^-[^-]/;

function getChangedSymbols(file) {
  const cmd = staged
    ? `git diff --cached -- ${file}`
    : `git diff ${sinceRef}..HEAD -- ${file}`;
  const diff = run(cmd);
  const added = new Set();
  const hasRemovals = diff.split('\n').some(l => REMOVED_LINE.test(l));

  for (const line of diff.split('\n')) {
    const em = ADDED_EXPORT.exec(line);
    if (em && em[1]) { added.add(em[1]); continue; }
    const fm = ADDED_FUNC.exec(line);
    // Only add non-trivial names (skip single-char, getters/setters patterns)
    if (fm && fm[1] && fm[1].length > 2 && !['if', 'for', 'while', 'switch'].includes(fm[1])) {
      added.add(fm[1]);
    }
  }
  return { symbols: [...added], hasRemovals };
}

// ─── Find all test files (not just changed ones) ──────────────────────────────
function getAllTestFiles() {
  const out = run('git ls-files "src/__tests__/*.test.ts" "src/__tests__/*.spec.ts" "**/*.test.ts" "**/*.spec.ts"');
  return out.split('\n').filter(Boolean);
}

function readTestFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return '';
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

// ─── Check coverage ───────────────────────────────────────────────────────────
const allTestFiles = getAllTestFiles();
const allTestContent = allTestFiles.map(f => readTestFile(f)).join('\n');

// Also check if there's a test file that corresponds to the source file
function correspondingTestPaths(sourceRel) {
  const base = basename(sourceRel, '.ts').replace('.tsx', '');
  return [
    sourceRel.replace('src/', 'src/__tests__/').replace(/\.tsx?$/, '.test.ts'),
    sourceRel.replace('src/', 'src/__tests__/').replace(/\.tsx?$/, '.spec.ts'),
    `src/__tests__/${base}.test.ts`,
    `src/__tests__/${base}.spec.ts`,
  ];
}

// ─── Main logic ───────────────────────────────────────────────────────────────
const results = [];
let uncoveredCount = 0;

for (const file of sourceFiles) {
  const { symbols, hasRemovals } = getChangedSymbols(file);
  if (symbols.length === 0 && !hasRemovals) continue;

  const corrTests = correspondingTestPaths(file).filter(t => existsSync(join(ROOT, t)));
  const hasCorrespondingTest = corrTests.length > 0;
  const changedTestFiles = testFiles.filter(t =>
    corrTests.some(ct => t.includes(basename(ct, '.ts')))
  );

  const uncoveredSymbols = symbols.filter(name => !allTestContent.includes(name));
  const testWasUpdated = changedTestFiles.length > 0;

  if (uncoveredSymbols.length > 0 && !testWasUpdated) {
    results.push({ file, symbols, uncoveredSymbols, hasCorrespondingTest, corrTests });
    uncoveredCount += uncoveredSymbols.length;
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────
const label = staged ? 'staged changes' : `${sinceRef}..HEAD`;
console.log(`${ANSI.bold}Behavior-change-without-test gate${ANSI.reset}  (${label})\n`);

if (results.length === 0) {
  console.log(`${ANSI.green}✓ All changed symbols have test coverage or test files were updated.${ANSI.reset}`);
  process.exit(0);
}

for (const { file, symbols, uncoveredSymbols, hasCorrespondingTest, corrTests } of results) {
  console.log(`${ANSI.yellow}⚠${ANSI.reset}  ${ANSI.bold}${file}${ANSI.reset}`);
  console.log(`   Changed symbols: ${symbols.join(', ')}`);
  console.log(`   ${ANSI.red}No test coverage:${ANSI.reset} ${uncoveredSymbols.join(', ')}`);
  if (!hasCorrespondingTest) {
    const suggested = corrTests[0] ? corrTests[0] : `src/__tests__/${basename(file, '.ts')}.test.ts`;
    console.log(`   ${ANSI.dim}No test file found. Create: ${suggested}${ANSI.reset}`);
  } else {
    console.log(`   ${ANSI.dim}Test file exists but wasn't updated.${ANSI.reset}`);
  }
  console.log();
}

console.log(`${ANSI.yellow}${ANSI.bold}${uncoveredCount} uncovered symbol(s) in ${results.length} file(s).${ANSI.reset}`);
if (!strict) {
  console.log(`${ANSI.dim}Pass --strict to make this a hard failure.${ANSI.reset}`);
  process.exit(0);
} else {
  process.exit(1);
}
