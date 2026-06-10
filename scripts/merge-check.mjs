#!/usr/bin/env node
/**
 * Pre-merge/commit validator.
 * Catches: conflict markers, duplicate exported symbols, dropped local exports.
 * Then runs tsc --noEmit + vitest.
 * Exit non-zero on any failure.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ANSI = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };

let errors = 0;
let warnings = 0;

function fail(msg) { console.error(`${ANSI.red}✗ FAIL${ANSI.reset} ${msg}`); errors++; }
function warn(msg) { console.warn(`${ANSI.yellow}⚠ WARN${ANSI.reset} ${msg}`); warnings++; }
function ok(msg)   { console.log(`${ANSI.green}✓${ANSI.reset} ${msg}`); }
function header(msg) { console.log(`\n${ANSI.bold}── ${msg} ──${ANSI.reset}`); }

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], ...opts });
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status ?? 1, failed: true };
  }
}

// ─── 1. Conflict markers ──────────────────────────────────────────────────────
header('1/4  Conflict markers');

const CONFLICT_PATTERNS = ['<<<<<<<', '=======', '>>>>>>>'];
const trackedFiles = run('git ls-files').split('\n').filter(Boolean);
const sourceFiles = trackedFiles.filter(f =>
  /\.(ts|tsx|js|mjs|json|md|sh|yaml|yml)$/.test(f) && !f.includes('node_modules')
);

let markerCount = 0;
for (const rel of sourceFiles) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  let content;
  try { content = readFileSync(abs, 'utf8'); } catch { continue; }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const pat of CONFLICT_PATTERNS) {
      if (line.startsWith(pat)) {
        fail(`${rel}:${i + 1}  conflict marker: ${line.slice(0, 60)}`);
        markerCount++;
      }
    }
  });
}
if (markerCount === 0) ok('No conflict markers found.');

// ─── 2. Duplicate exported symbols within a file ─────────────────────────────
header('2/4  Duplicate exported symbols');

const tsFiles = sourceFiles.filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('.d.ts'));
// Matches: export function X / export class X / export const X / export type X / export interface X / export enum X
const EXPORT_RE = /^export\s+(?:(?:async|default)\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
// Also: export { X, Y as Z }
const EXPORT_BRACE_RE = /^export\s*\{([^}]+)\}/;

let dupCount = 0;
for (const rel of tsFiles) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  let content;
  try { content = readFileSync(abs, 'utf8'); } catch { continue; }
  const lines = content.split('\n');
  const seen = new Map(); // name -> first line number
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = EXPORT_RE.exec(line);
    if (m && m[1] && m[1] !== 'default') {
      const name = m[1];
      if (seen.has(name)) {
        fail(`${rel}:${i + 1}  duplicate export '${name}' (first at line ${seen.get(name)})`);
        dupCount++;
      } else {
        seen.set(name, i + 1);
      }
    }
  }
}
if (dupCount === 0) ok('No duplicate exported symbols found.');

// ─── 3. Dropped local exports (imported but not exported) ───────────────────
header('3/4  Dropped local exports');

// Collect all exports per file: abs path -> Set<name>
const exportMap = new Map();

function getExports(absPath) {
  if (exportMap.has(absPath)) return exportMap.get(absPath);
  const names = new Set();
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return names; }
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // export function/class/const/etc.
    const m = EXPORT_RE.exec(trimmed);
    if (m && m[1]) names.add(m[1]);
    // export { X, Y as Z, ... }
    const bm = EXPORT_BRACE_RE.exec(trimmed);
    if (bm) {
      bm[1].split(',').forEach(part => {
        const alias = part.trim().split(/\s+as\s+/).pop().trim();
        if (alias && /^[A-Za-z_$]/.test(alias)) names.add(alias);
      });
    }
    // export default function/class without name -> 'default'
    if (/^export\s+default\s/.test(trimmed)) names.add('default');
  }
  exportMap.set(absPath, names);
  return names;
}

// Named import: import { X, Y } from './path'
const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
// Also import * as X from  (we won't validate wildcard)
// Also default import: import X from './path'  -> name 'default'
const DEFAULT_IMPORT_RE = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*['"](\.[^'"]+)['"]/g;

let droppedCount = 0;
for (const rel of tsFiles) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  let content;
  try { content = readFileSync(abs, 'utf8'); } catch { continue; }

  let m;
  // Named imports
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const importedNames = m[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts[0].trim(); // original name (before 'as')
    }).filter(n => n && /^[A-Za-z_$]/.test(n) && n !== 'type');
    const rawPath = m[2];
    const resolved = resolveImport(abs, rawPath);
    if (!resolved) continue;
    const exports = getExports(resolved);
    for (const name of importedNames) {
      if (name === 'type') continue; // type-only imports
      if (!exports.has(name)) {
        warn(`${rel}: imports '${name}' from '${rawPath}' but it is not exported there (dropped export?)`);
        droppedCount++;
      }
    }
  }
}
if (droppedCount === 0) ok('No dropped local exports detected.');

function resolveImport(fromAbs, importPath) {
  const base = join(dirname(fromAbs), importPath);
  // Try extensions in order
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '/index.js']) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── 4. tsc --noEmit ─────────────────────────────────────────────────────────
header('4a/4  TypeScript check (tsc --noEmit)');

const tscResult = spawnSync('npx', ['tsc', '--noEmit'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
});
if (tscResult.status !== 0) {
  const out = (tscResult.stdout + tscResult.stderr).trim();
  // Print first 30 lines only
  const lines = out.split('\n').slice(0, 30);
  lines.forEach(l => console.error(`  ${l}`));
  if (out.split('\n').length > 30) console.error('  ... (truncated)');
  fail('tsc --noEmit reported errors.');
} else {
  ok('tsc --noEmit passed.');
}

// ─── 5. vitest ───────────────────────────────────────────────────────────────
header('4b/4  Tests (vitest run)');

if (errors > 0) {
  warn('Skipping tests -- fix the above errors first.');
} else {
  const testResult = spawnSync('npx', ['vitest', 'run', '--reporter=verbose'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'inherit'
  });
  if (testResult.status !== 0) {
    fail('vitest reported test failures.');
  } else {
    ok('All tests passed.');
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log();
if (errors > 0) {
  console.error(`${ANSI.red}${ANSI.bold}FAILED${ANSI.reset}  ${errors} error(s), ${warnings} warning(s).`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`${ANSI.yellow}${ANSI.bold}PASSED with warnings${ANSI.reset}  0 errors, ${warnings} warning(s).`);
  process.exit(0);
} else {
  console.log(`${ANSI.green}${ANSI.bold}ALL CLEAR${ANSI.reset}  0 errors, 0 warnings.`);
  process.exit(0);
}
