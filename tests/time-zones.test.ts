import { describe, it, expect } from 'vitest'
import { zoneLabel, zoneOptions } from '../src/renderer/src/lib/time-zones'

describe('time zone picker', () => {
  it('labels a zone with its name and the offset it has today', () => {
    expect(zoneLabel('Asia/Ho_Chi_Minh')).toBe('Asia/Ho Chi Minh (GMT+7)')
    expect(zoneLabel('Asia/Kolkata')).toBe('Asia/Kolkata (GMT+5:30)')
    expect(zoneLabel('Not/A_Zone')).toBe('Not/A Zone')
  })

  it('offers every zone the runtime knows', () => {
    const values = zoneOptions().map((o) => o.value)
    expect(values.length).toBeGreaterThan(300)
    expect(values).toContain('Europe/Berlin')
  })
})
