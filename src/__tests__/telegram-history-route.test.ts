import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression: the CLAUDE.md recipe POSTs every Telegram message to
// /api/telegram-history, but the route only existed on the old gergely-dev
// branch. On main every save was a silent 404 and the table froze at
// 2026-07-09. Pin both the route and its registration in the dispatcher.
const webTs = readFileSync(join(__dirname, '../web.ts'), 'utf8')
const routeTs = readFileSync(join(__dirname, '../web/routes/telegram-history.ts'), 'utf8')

describe('telegram-history route', () => {
  it('is registered in the web dispatcher', () => {
    expect(webTs).toContain("from './web/routes/telegram-history.js'")
    expect(webTs).toContain('await tryHandleTelegramHistory(routeCtx)')
  })

  it('handles POST (save) and GET (history) on /api/telegram-history', () => {
    expect(routeTs).toMatch(/path === '\/api\/telegram-history' && method === 'POST'/)
    expect(routeTs).toMatch(/path === '\/api\/telegram-history' && method === 'GET'/)
    expect(routeTs).toContain('saveTelegramMessage(')
    expect(routeTs).toContain('getTelegramHistory(')
  })
})
