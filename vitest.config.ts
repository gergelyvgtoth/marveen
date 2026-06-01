import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // setup.ts redirects STORE_DIR to a temp dir so tests never touch the
    // live store/claudeclaw.db.
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
