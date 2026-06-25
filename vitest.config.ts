import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate.
export default defineConfig({
  test: {
    // setup.ts redirects STORE_DIR to a temp dir so tests never touch the
    // live store/claudeclaw.db.
    setupFiles: ['./src/__tests__/setup.ts'],
    // Only run TS sources; never the compiled copies under dist/ or the
    // deploy rollback snapshot dist.prev/.
    include: ['src/**/*.{test,spec}.ts'],
    exclude: [...configDefaults.exclude, 'dist/**', 'dist.prev/**', 'tests/smoke/**'],
  },
})
