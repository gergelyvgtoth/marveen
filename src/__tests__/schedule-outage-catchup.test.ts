import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCHEDULE_ALWAYS_CATCHUP_MAX_MS,
  SCHEDULE_MAX_CATCHUP_MS,
  computeCatchUpStart,
  taskScanFromMs,
} from '../web/schedule-runner.js'
import { cronPrevOccurrence } from '../web/cron.js'

// 2026-10-19..28: the host was off for 9 days. The 24 h catch-up ceiling kept
// every weekly watcher's single missed occurrence out of the first tick's scan
// window, so none of them ran and the owner had to ask for a manual replay.
// A task that ALWAYS catches up (catchUpMaxAgeMinutes < 0) now scans back to
// the real liveness stamp on the first tick, bounded by a 30-day ceiling.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
const H = 3_600_000
const D = 24 * H
const now = Date.UTC(2026, 9, 28, 22, 0)
const stamp = now - 9 * D
const always = { type: 'heartbeat', catchUpMaxAgeMinutes: -1 }
const normal = { type: 'heartbeat' }

describe('taskScanFromMs: outage catch-up for always-catch-up tasks', () => {
  const fromMs = computeCatchUpStart(stamp, now)

  it('the fleet-wide window stays capped at 24 h', () => {
    expect(fromMs).toBe(now - SCHEDULE_MAX_CATCHUP_MS)
    expect(taskScanFromMs(normal, fromMs, stamp, now)).toBe(fromMs)
    expect(taskScanFromMs({ type: 'task', catchUpMaxAgeMinutes: 600 }, fromMs, stamp, now)).toBe(fromMs)
  })

  it('an always-catch-up task scans back to the liveness stamp', () => {
    expect(taskScanFromMs(always, fromMs, stamp, now)).toBe(stamp)
  })

  it('a weekly Monday watcher missed 5 days ago is found only through the outage window', () => {
    const weekly = '0 9 * * 1'
    expect(cronPrevOccurrence(weekly, fromMs, now)).toBeNull()
    const occ = cronPrevOccurrence(weekly, taskScanFromMs(always, fromMs, stamp, now), now)
    expect(occ).not.toBeNull()
    expect(occ!).toBeLessThan(fromMs)
  })

  it('the outer ceiling bounds a very long outage', () => {
    const ancient = now - 90 * D
    expect(taskScanFromMs(always, fromMs, ancient, now)).toBe(now - SCHEDULE_ALWAYS_CATCHUP_MAX_MS)
  })

  it('no stamp, a future stamp, or a later tick leaves the window alone', () => {
    expect(taskScanFromMs(always, fromMs, null, now)).toBe(fromMs)
    expect(taskScanFromMs(always, fromMs, now + H, now)).toBe(fromMs)
    expect(taskScanFromMs(always, fromMs, Number.NaN, now)).toBe(fromMs)
  })

  it('a short gap inside the 24 h window never widens it', () => {
    const recent = now - 2 * H
    const f = computeCatchUpStart(recent, now)
    expect(taskScanFromMs(always, f, recent, now)).toBe(f)
  })

  it('only the first tick reaches past the ceiling: the stamp is cleared with the startup gap', () => {
    expect(SRC).toMatch(/pendingStartupGapMs = 0\n\s*pendingOutageFromMs = null/)
    expect(SRC).toMatch(/const taskFromMs = taskScanFromMs\(task, fromMs, pendingOutageFromMs, now\)/)
    expect(SRC).toMatch(/if \(lastRun >= taskFromMs\) continue/)
  })
})
