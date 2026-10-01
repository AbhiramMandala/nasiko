import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuid } from './utils'

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a v4 UUID with or without crypto.randomUUID (plain HTTP has none)', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(uuid()).toMatch(v4)
    const real = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a),
    })
    expect(crypto.randomUUID).toBeUndefined()
    const ids = new Set(Array.from({ length: 50 }, uuid))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(v4)
  })
})
