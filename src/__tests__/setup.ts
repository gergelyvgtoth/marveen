// Vitest global setup: redirect Marveen's store dir to a throwaway temp dir
// BEFORE config.ts (and thus the DB) is loaded, so tests never read or write
// the live store/claudeclaw.db. Runs before each test file's imports.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.MARVEEN_STORE_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-test-'))
  process.env.MARVEEN_STORE_DIR = dir
}
process.env.NODE_ENV = 'test'
