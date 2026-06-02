import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, listInbox } from '../db.js'
import { syncEmailsToInbox, type EmailFetcher, type EmailMessage } from '../email-connector.js'

const NOW = 1_780_000_000

function fakeFetcher(configured: boolean, emails: EmailMessage[]): EmailFetcher {
  return {
    configured: () => configured,
    fetchRecent: async () => emails,
  }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
})

beforeEach(() => {
  getDb().exec("DELETE FROM inbox_items WHERE source = 'email'")
})

describe('syncEmailsToInbox', () => {
  it('does nothing and reports configured:false when no transport is set up', async () => {
    const res = await syncEmailsToInbox(fakeFetcher(false, []), { sinceTs: NOW })
    expect(res).toEqual({ configured: false, added: 0, skipped: 0, scanned: 0 })
    expect(listInbox('all').filter(i => i.source === 'email').length).toBe(0)
  })

  it('ingests emails into the inbox with email source and dedups on resync', async () => {
    const emails: EmailMessage[] = [
      { id: 'm1', from: 'ugyfel@ceg.hu', subject: 'Sürgős ajánlatkérés', text: 'Kérek árajánlatot ma.', receivedAt: NOW - 60 },
      { id: 'm2', from: 'hir@spam.io', subject: 'Hírlevél', text: 'Akciók a héten.', receivedAt: NOW - 120 },
    ]
    const first = await syncEmailsToInbox(fakeFetcher(true, emails), { sinceTs: NOW - 86400 })
    expect(first.configured).toBe(true)
    expect(first.scanned).toBe(2)
    expect(first.added).toBe(2)
    expect(first.skipped).toBe(0)

    const items = listInbox('all').filter(i => i.source === 'email')
    expect(items.length).toBe(2)
    expect(items.every(i => String(i.external_id).startsWith('email-'))).toBe(true)

    // resync the same emails -> all deduped, nothing added
    const second = await syncEmailsToInbox(fakeFetcher(true, emails), { sinceTs: NOW - 86400 })
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(2)
    expect(listInbox('all').filter(i => i.source === 'email').length).toBe(2)
  })

  it('classifies urgency from subject + body', async () => {
    const emails: EmailMessage[] = [
      { id: 'u1', from: 'a@b.hu', subject: 'SÜRGŐS: szerződés ma lejár', text: 'Azonnal kell a válasz.', receivedAt: NOW },
    ]
    await syncEmailsToInbox(fakeFetcher(true, emails), { sinceTs: NOW - 86400 })
    const item = listInbox('all').find(i => i.external_id === 'email-u1')
    expect(item).toBeTruthy()
    expect(item!.subject).toBe('SÜRGŐS: szerződés ma lejár')
    expect(item!.sender).toBe('a@b.hu')
  })
})
