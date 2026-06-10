import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /api/version -- a short signature of the currently-served frontend assets
// (+ the backend build marker). The dashboard polls this and nudges a reload
// when it changes, so an edit to app.js/index.html (served live from disk, no
// rebuild) or a backend redeploy no longer leaves the open tab on stale code.
//
// Computed per request from stat (size + mtime), which is cheap and reflects
// the on-disk files without caching staleness.
function assetSignature(webDir: string): string {
  const h = createHash('sha1')
  for (const name of ['app.js', 'index.html', 'style.css']) {
    const p = join(webDir, name)
    try {
      const s = statSync(p)
      h.update(`${name}:${s.size}:${Math.floor(s.mtimeMs)};`)
    } catch {
      h.update(`${name}:missing;`)
    }
  }
  // Backend build marker (best-effort) so a dist redeploy also bumps the version.
  try {
    const s = statSync(join(webDir, '..', 'dist', 'index.js'))
    h.update(`dist:${Math.floor(s.mtimeMs)}`)
  } catch {
    /* dist marker is optional */
  }
  return h.digest('hex').slice(0, 12)
}

export async function tryHandleVersion(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/version' && method === 'GET') {
    json(res, { version: assetSignature(webDir), now: Date.now() })
    return true
  }
  return false
}
