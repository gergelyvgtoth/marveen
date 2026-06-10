#!/usr/bin/env node
// Frontend DOM smoke test for the dashboard.
//
// `tsc` + `node --check` only prove app.js *parses*. They miss runtime
// regressions: an init call that throws, a renamed/removed element ID the JS
// still wires to, a function that stopped being defined. This loads the real
// index.html in jsdom, runs the real app.js with the handful of browser APIs
// jsdom lacks stubbed out, and asserts our code initialises cleanly.
//
// A real headless browser (Playwright) is the ideal, but it refuses to install
// chromium on this OS (ubuntu26.04-x64) and there's no system Chrome, so jsdom
// gives the portable 80%: it catches init/wiring breakage without a browser.
//
// Exit 0 = PASS, non-zero = FAIL. Run before promoting a frontend change.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

// Uncaught SYNCHRONOUS errors during script execution surface here -- these are
// the real regressions (top-level init throw, wiring to a missing element).
const fatalErrors = []
// Async noise (a stubbed fetch returning the wrong shape to a deep page loader)
// is collected but not fatal -- we're gating our wiring, not jsdom fidelity.
const warnings = []

const vc = new VirtualConsole()
vc.on('jsdomError', e => fatalErrors.push(e?.message || String(e)))

// Drop external <script src> tags (CDN xterm + /app.js) so jsdom doesn't fetch
// them; we inject app.js ourselves after the API stubs are in place.
const htmlNoScripts = html.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '')

const dom = new JSDOM(htmlNoScripts, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'http://localhost:3420/',
})
const { window } = dom

// --- Stub the browser APIs jsdom doesn't implement.
window.fetch = async (input) => {
  const url = String(input)
  const body = url.includes('/api/version') ? { version: 'smoke', now: 0 }
    : url.includes('/api/auth/status') ? { authenticated: true }
    : []
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  }
}
window.EventSource = class { close() {} addEventListener() {} }
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
}
window.Terminal = class { open() {} write() {} onData() {} loadAddon() {} dispose() {} }
window.FitAddon = { FitAddon: class { fit() {} activate() {} } }
if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {}
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' } })
}

window.addEventListener('error', e => warnings.push('error: ' + (e?.error?.message || e?.message || 'unknown')))
window.addEventListener('unhandledrejection', e => warnings.push('rejection: ' + (e?.reason?.message || String(e?.reason) || 'unknown')))

// --- Run app.js in the jsdom global scope.
const script = window.document.createElement('script')
script.textContent = appJs
window.document.body.appendChild(script)

// Let queued microtasks/timers tick so async init errors surface.
await new Promise(r => setTimeout(r, 250))

// --- Assert the elements the recent console features wire to exist.
const requiredIds = [
  'consoleTabs', 'consoleModeLive', 'consoleModeHistory',
  'consoleSearch', 'consoleSearchPrev', 'consoleSearchNext', 'consoleSearchAll',
  'consoleOutput', 'consoleStatus',
]
const missingIds = requiredIds.filter(id => !window.document.getElementById(id))

// --- Assert the key global functions are defined (top-level wiring sanity).
const requiredFns = [
  'loadConsolePage', 'consoleTick', 'setConsoleMode', 'loadConsoleTranscript',
  'loadConsoleFleetSearch', 'renderConsoleOutput', 'checkAppVersion',
]
const missingFns = requiredFns.filter(fn => typeof window[fn] !== 'function')

const problems = []
if (fatalErrors.length) problems.push(`${fatalErrors.length} uncaught error(s):\n    - ` + fatalErrors.slice(0, 8).join('\n    - '))
if (missingIds.length) problems.push('missing elements: ' + missingIds.join(', '))
if (missingFns.length) problems.push('missing functions: ' + missingFns.join(', '))

if (warnings.length) {
  console.log(`(${warnings.length} non-fatal async warning(s) from stubbed fetch -- ignored)`)
}

if (problems.length) {
  console.error('FRONTEND SMOKE: FAIL')
  for (const p of problems) console.error('  x ' + p)
  process.exit(1)
}

console.log('FRONTEND SMOKE: PASS')
console.log(`  ok app.js initialised clean; ${requiredIds.length} elements + ${requiredFns.length} functions present`)
process.exit(0)
