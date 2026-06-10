#!/usr/bin/env node
/**
 * Fork divergence manifest.
 * Shows every exported symbol that exists in HEAD but not in upstream/main.
 * Run before a re-merge to know exactly what local-only features must be preserved.
 *
 * Usage:
 *   node scripts/fork-diff.mjs [--upstream upstream/main] [--json]
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ANSI = {
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
  cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m'
};

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const upstreamIdx = args.indexOf('--upstream');
const UPSTREAM = upstreamIdx >= 0 ? args[upstreamIdx + 1] : 'upstream/main';

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '').trim();
  }
}

// ─── Resolve merge-base ───────────────────────────────────────────────────────
let mergeBase;
try {
  mergeBase = run(`git merge-base ${UPSTREAM} HEAD`);
} catch {
  console.error(`Cannot find merge-base with ${UPSTREAM}. Is the remote fetched?`);
  process.exit(1);
}

const headRef = run('git rev-parse --short HEAD');
const upstreamRef = run(`git rev-parse --short ${UPSTREAM}`);

if (!jsonMode) {
  console.log(`${ANSI.bold}Fork divergence manifest${ANSI.reset}`);
  console.log(`  HEAD:     ${headRef}  (${run('git rev-parse --abbrev-ref HEAD')})`);
  console.log(`  Upstream: ${upstreamRef}  (${UPSTREAM})`);
  console.log(`  Base:     ${mergeBase.slice(0, 8)}\n`);
}

// ─── Files changed locally (HEAD vs upstream) ────────────────────────────────
const changedFiles = run(`git diff ${UPSTREAM}...HEAD --name-only`)
  .split('\n').filter(Boolean);

const localOnlyFiles = run(`git diff ${UPSTREAM}...HEAD --diff-filter=A --name-only`)
  .split('\n').filter(Boolean);

const modifiedFiles = run(`git diff ${UPSTREAM}...HEAD --diff-filter=M --name-only`)
  .split('\n').filter(Boolean);

const deletedInLocal = run(`git diff ${UPSTREAM}...HEAD --diff-filter=D --name-only`)
  .split('\n').filter(Boolean);

// ─── Extract exports from a git object ───────────────────────────────────────
const EXPORT_RE = /^export\s+(?:(?:async|default)\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const EXPORT_BRACE_RE = /^export\s*\{([^}]+)\}/;

function extractExports(content) {
  const names = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const m = EXPORT_RE.exec(trimmed);
    if (m && m[1]) names.add(m[1]);
    const bm = EXPORT_BRACE_RE.exec(trimmed);
    if (bm) {
      bm[1].split(',').forEach(part => {
        const alias = part.trim().split(/\s+as\s+/).pop().trim();
        if (alias && /^[A-Za-z_$]/.test(alias)) names.add(alias);
      });
    }
  }
  return names;
}

function getFileAtRef(ref, path) {
  try {
    return execSync(`git show ${ref}:${path}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  } catch {
    return null;
  }
}

// ─── Build manifest ───────────────────────────────────────────────────────────
const manifest = {
  upstream: UPSTREAM,
  head: headRef,
  base: mergeBase.slice(0, 8),
  localOnlyFiles: [],    // files that only exist in HEAD
  deletedInLocal: [],    // files deleted vs upstream (upstream has them, HEAD doesn't)
  modifiedSymbols: [],   // per-file: {file, added: [], removed: []}
};

// 1. Files added in fork
const tsOnlyFiles = localOnlyFiles.filter(f => /\.(ts|tsx|mjs|js)$/.test(f) && !f.includes('node_modules'));
for (const f of tsOnlyFiles) {
  const content = getFileAtRef('HEAD', f) || '';
  const exports = [...extractExports(content)];
  manifest.localOnlyFiles.push({ file: f, exports });
}

// 2. Files deleted in fork (exist upstream, gone locally)
manifest.deletedInLocal = deletedInLocal.filter(f => /\.(ts|tsx)$/.test(f));

// 3. Modified files: diff symbols
const tsModified = modifiedFiles.filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('node_modules'));
for (const f of tsModified) {
  const headContent = getFileAtRef('HEAD', f) || '';
  const upContent = getFileAtRef(UPSTREAM, f) || '';
  const headExports = extractExports(headContent);
  const upExports = extractExports(upContent);

  const added = [...headExports].filter(n => !upExports.has(n));
  const removed = [...upExports].filter(n => !headExports.has(n));

  if (added.length > 0 || removed.length > 0) {
    manifest.modifiedSymbols.push({ file: f, added, removed });
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────
if (jsonMode) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const totalPreserve = manifest.localOnlyFiles.reduce((s, f) => s + f.exports.length, 0)
  + manifest.modifiedSymbols.reduce((s, f) => s + f.added.length, 0);

// Local-only files
if (manifest.localOnlyFiles.length > 0) {
  console.log(`${ANSI.bold}${ANSI.cyan}NEW FILES (local-only, ${manifest.localOnlyFiles.length})${ANSI.reset}`);
  for (const { file, exports } of manifest.localOnlyFiles) {
    console.log(`  ${ANSI.green}+${ANSI.reset} ${file}`);
    if (exports.length > 0) {
      console.log(`    ${ANSI.dim}exports: ${exports.join(', ')}${ANSI.reset}`);
    }
  }
  console.log();
}

// Deleted files
if (manifest.deletedInLocal.length > 0) {
  console.log(`${ANSI.bold}${ANSI.red}DELETED LOCALLY (exist in upstream, ${manifest.deletedInLocal.length})${ANSI.reset}`);
  for (const f of manifest.deletedInLocal) {
    console.log(`  ${ANSI.red}-${ANSI.reset} ${f}`);
  }
  console.log();
}

// Modified: added symbols
const withAdded = manifest.modifiedSymbols.filter(f => f.added.length > 0);
if (withAdded.length > 0) {
  console.log(`${ANSI.bold}${ANSI.cyan}LOCAL-ONLY SYMBOLS IN MODIFIED FILES (${withAdded.length} files)${ANSI.reset}`);
  console.log(`  ${ANSI.dim}These symbols exist in HEAD but not in ${UPSTREAM} -- preserve on next merge.${ANSI.reset}`);
  for (const { file, added } of withAdded) {
    console.log(`  ${ANSI.green}~${ANSI.reset} ${file}`);
    console.log(`    ${ANSI.dim}local-only: ${added.join(', ')}${ANSI.reset}`);
  }
  console.log();
}

// Modified: removed symbols (in upstream, gone locally -- intentional deletions)
const withRemoved = manifest.modifiedSymbols.filter(f => f.removed.length > 0);
if (withRemoved.length > 0) {
  console.log(`${ANSI.bold}${ANSI.yellow}REMOVED FROM UPSTREAM (intentional? ${withRemoved.length} files)${ANSI.reset}`);
  console.log(`  ${ANSI.dim}These symbols exist in ${UPSTREAM} but not in HEAD.${ANSI.reset}`);
  for (const { file, removed } of withRemoved) {
    console.log(`  ${ANSI.yellow}~${ANSI.reset} ${file}`);
    console.log(`    ${ANSI.dim}removed: ${removed.join(', ')}${ANSI.reset}`);
  }
  console.log();
}

// Summary
console.log(`${ANSI.bold}Summary${ANSI.reset}`);
console.log(`  ${changedFiles.length} files differ from upstream`);
console.log(`  ${manifest.localOnlyFiles.length} files are local-only`);
console.log(`  ${totalPreserve} symbols to preserve on next merge`);
if (totalPreserve === 0 && manifest.localOnlyFiles.length === 0 && manifest.deletedInLocal.length === 0) {
  console.log(`\n  ${ANSI.green}No divergence -- fork is in sync with upstream.${ANSI.reset}`);
}
