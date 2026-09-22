import { describe, it, expect } from 'vitest'
import { nextEnabledIndex, firstEnabledIndex } from '../src/renderer/src/lib/roving-index'

/**
 * Every picker draws its list into a portal at the end of `<body>`, so the
 * keyboard can never tab into one - focus stays on the trigger and this index
 * is what moves. A read-only calendar in the calendar select is the disabled
 * case that matters in practice: the arrows have to step over it.
 */
interface Option {
  value: string
  disabled?: boolean
}

const disabled = (o: Option): boolean => Boolean(o.disabled)

const opts = (...spec: string[]): Option[] =>
  spec.map((s) => (s.endsWith('!') ? { value: s.slice(0, -1), disabled: true } : { value: s }))

describe('nextEnabledIndex', () => {
  const plain = opts('a', 'b', 'c')

  it('steps one either way', () => {
    expect(nextEnabledIndex(plain, 0, 1)).toBe(1)
    expect(nextEnabledIndex(plain, 2, -1)).toBe(1)
  })

  it('wraps around both ends', () => {
    expect(nextEnabledIndex(plain, 2, 1)).toBe(0)
    expect(nextEnabledIndex(plain, 0, -1)).toBe(2)
  })

  it('steps over disabled entries', () => {
    const list = opts('a', 'b!', 'c')
    expect(nextEnabledIndex(list, 0, 1, disabled)).toBe(2)
    expect(nextEnabledIndex(list, 2, -1, disabled)).toBe(0)
  })

  it('skips a run of disabled entries, wrapping if it has to', () => {
    const list = opts('a', 'b!', 'c!', 'd!')
    expect(nextEnabledIndex(list, 0, 1, disabled)).toBe(0)
  })

  it('stays put when nothing else can be landed on', () => {
    const list = opts('a', 'b!')
    expect(nextEnabledIndex(list, 0, 1, disabled)).toBe(0)
  })

  it('enters from the matching end when nothing is active yet', () => {
    expect(nextEnabledIndex(plain, -1, 1)).toBe(0)
    expect(nextEnabledIndex(plain, -1, -1)).toBe(2)
  })

  it('enters from the matching end when the index is stale', () => {
    // A filtered list can shrink out from under the cursor.
    expect(nextEnabledIndex(plain, 9, 1)).toBe(0)
  })

  it('reports nothing for an empty list', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1)
    expect(nextEnabledIndex([], -1, -1)).toBe(-1)
  })
})

describe('firstEnabledIndex', () => {
  it('finds the first selectable entry from either end', () => {
    const list = opts('a!', 'b', 'c', 'd!')
    expect(firstEnabledIndex(list, 'start', disabled)).toBe(1)
    expect(firstEnabledIndex(list, 'end', disabled)).toBe(2)
  })

  it('reports -1 when every entry is disabled', () => {
    expect(firstEnabledIndex(opts('a!', 'b!'), 'start', disabled)).toBe(-1)
  })

  it('reports -1 for an empty list', () => {
    expect(firstEnabledIndex([], 'start')).toBe(-1)
  })
})
