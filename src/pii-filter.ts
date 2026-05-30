/**
 * PII filter — masks personal identifiable information before it enters Claude's context.
 * Applied to: memory content, session context, heartbeat prompts, kanban descriptions.
 */

const PII_PATTERNS: { label: string; pattern: RegExp }[] = [
  // Email addresses
  { label: '[EMAIL]', pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },

  // Hungarian phone numbers: +36 XX XXX XXXX, 06-XX-XXX-XXXX, etc.
  { label: '[TELEFON]', pattern: /(\+36|06)[\s\-]?\d{1,2}[\s\-]?\d{3}[\s\-]?\d{4}/g },

  // Hungarian tax number: 12345678-1-12
  { label: '[ADÓSZÁM]', pattern: /\b\d{8}-\d{1}-\d{2}\b/g },

  // EU VAT number: HU12345678
  { label: '[ADÓSZÁM]', pattern: /\b[A-Z]{2}\d{8,12}\b/g },

  // Hungarian company registration: Cg. XX-XX-XXXXXX
  { label: '[CÉGJEGYZÉK]', pattern: /\bCg\.?\s*\d{2}[-\s]\d{2}[-\s]\d{6}\b/gi },

  // Bank account (IBAN-like): HU + 26 digits, or XX-XXXXXXXX-XXXXXXXX
  { label: '[BANKSZÁMLA]', pattern: /\bHU\d{26}\b/g },
  { label: '[BANKSZÁMLA]', pattern: /\b\d{8}-\d{8}-\d{8}\b/g },
]

export function maskPII(text: string): string {
  let result = text
  for (const { label, pattern } of PII_PATTERNS) {
    result = result.replace(pattern, label)
  }
  return result
}

export function containsPII(text: string): boolean {
  return PII_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** Mask PII in an object's string values recursively (for JSON payloads). */
export function maskPIIDeep<T>(obj: T): T {
  if (typeof obj === 'string') return maskPII(obj) as unknown as T
  if (Array.isArray(obj)) return obj.map(maskPIIDeep) as unknown as T
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = maskPIIDeep(v)
    }
    return result as T
  }
  return obj
}
