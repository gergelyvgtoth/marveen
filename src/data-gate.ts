/**
 * Marveen Outbound Data Gate
 * Controls what data can leave the local environment and reach Claude Code / external models.
 *
 * Every piece of data passing to external context goes through this gate.
 * Security default: local_only — nothing leaves unless explicitly allowed.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { maskPII } from './pii-filter.js'
import { logger } from './logger.js'

export type Sensitivity = 'pii' | 'sensitive' | 'technical' | 'public'
export type Scope = 'local_only' | 'claude_code_ok' | 'none'

export interface DataPolicy {
  defaults: { sensitivity: Sensitivity; scope: Scope; ttl_days: number | null }
  rules: { match_sensitivity: Sensitivity; scope: Scope; ttl_days: number | null }[]
  outbound_gate: {
    pseudonymize_pii: boolean
    block_on_uncertain: boolean
    log_outbound: boolean
    max_outbound_memories: number
  }
}

let _policy: DataPolicy | null = null

export function loadDataPolicy(): DataPolicy {
  if (_policy) return _policy
  const path = join(STORE_DIR, 'data-policy.json')
  if (existsSync(path)) {
    try {
      _policy = JSON.parse(readFileSync(path, 'utf-8')) as DataPolicy
      return _policy
    } catch (err) {
      logger.warn({ err }, 'data-policy.json parse failed, using safe defaults')
    }
  }
  // Ultra-safe fallback: nothing leaves
  _policy = {
    defaults: { sensitivity: 'technical', scope: 'local_only', ttl_days: 30 },
    rules: [],
    outbound_gate: {
      pseudonymize_pii: true,
      block_on_uncertain: true,
      log_outbound: true,
      max_outbound_memories: 8,
    },
  }
  return _policy
}

export function reloadDataPolicy(): void {
  _policy = null
  loadDataPolicy()
}

export interface GateableItem {
  id: number | string
  content: string
  sensitivity?: Sensitivity | null
  scope?: Scope | null
  category?: string
}

export interface GateResult {
  allowed: boolean
  reason: string
  content: string
}

/**
 * Decide if a single item may pass through the outbound gate.
 * Returns { allowed, reason, content } where content may be pseudonymized.
 */
export function applyGate(item: GateableItem): GateResult {
  const policy = loadDataPolicy()
  const gate = policy.outbound_gate

  // Determine effective scope
  const scope = item.scope ?? policy.defaults.scope
  const sensitivity = item.sensitivity ?? policy.defaults.sensitivity

  // BLOCK: local_only items never leave
  if (scope === 'local_only') {
    return { allowed: false, reason: 'scope:local_only', content: '' }
  }

  // BLOCK: none items never leave
  if (scope === 'none') {
    return { allowed: false, reason: 'scope:none', content: '' }
  }

  // BLOCK: uncertain items if policy says so
  if (!item.scope && gate.block_on_uncertain) {
    return { allowed: false, reason: 'scope:uncertain+block_on_uncertain', content: '' }
  }

  // scope == claude_code_ok from here
  let content = item.content

  // PII sensitivity: pseudonymize or block
  if (sensitivity === 'pii') {
    if (gate.pseudonymize_pii) {
      content = maskPII(content)
      return { allowed: true, reason: 'pii:pseudonymized', content }
    }
    return { allowed: false, reason: 'pii:blocked', content: '' }
  }

  // sensitive: only if explicitly claude_code_ok
  if (sensitivity === 'sensitive' && scope !== 'claude_code_ok') {
    return { allowed: false, reason: 'sensitive:no_explicit_permission', content: '' }
  }

  return { allowed: true, reason: `ok:${sensitivity}`, content }
}

/**
 * Filter a list of items through the gate.
 * Returns only allowed items, with content possibly pseudonymized.
 * Logs outbound items if policy.log_outbound is true.
 */
export function filterOutbound<T extends GateableItem>(
  items: T[],
  purpose: string
): (T & { content: string })[] {
  const policy = loadDataPolicy()
  const gate = policy.outbound_gate
  const allowed: (T & { content: string })[] = []
  let blocked = 0

  for (const item of items) {
    const result = applyGate(item)
    if (result.allowed) {
      allowed.push({ ...item, content: result.content })
      if (gate.log_outbound) {
        logger.debug({ id: item.id, reason: result.reason, purpose }, 'DataGate: outbound allowed')
      }
    } else {
      blocked++
      if (gate.log_outbound) {
        logger.debug({ id: item.id, reason: result.reason, purpose }, 'DataGate: outbound blocked')
      }
    }
  }

  if (blocked > 0) {
    logger.info({ allowed: allowed.length, blocked, purpose }, 'DataGate: filtered outbound data')
  }

  // Respect max_outbound_memories
  return allowed.slice(0, gate.max_outbound_memories)
}

/**
 * Infer sensitivity from content using simple heuristics.
 * Used when a memory is saved without explicit sensitivity.
 */
export function inferSensitivity(content: string, category?: string): Sensitivity {
  const lower = content.toLowerCase()

  // PII indicators
  if (/\b(email|telefon|phone|address|cím|születés|ssn|tajszám|útlevél)\b/i.test(content)) return 'pii'

  // Category-based inference
  if (category === 'hot') return 'sensitive'
  if (category === 'warm') return 'technical'
  if (category === 'cold') return 'technical'
  if (category === 'shared') return 'technical'

  // Sensitive indicators
  if (/\b(ügyfél|tárgyalás|ajánlat|szerződés|árajánlat|titkos|konfidenciális)\b/i.test(lower)) return 'sensitive'

  // Technical by default
  return 'technical'
}

/**
 * Apply policy rules to compute effective scope and ttl_days for a new memory.
 */
export function applyPolicyRules(sensitivity: Sensitivity): { scope: Scope; ttl_days: number | null } {
  const policy = loadDataPolicy()
  const rule = policy.rules.find(r => r.match_sensitivity === sensitivity)
  if (rule) return { scope: rule.scope, ttl_days: rule.ttl_days ?? null }
  return { scope: policy.defaults.scope, ttl_days: policy.defaults.ttl_days ?? null }
}
