// Unit tests for src/cron.ts — mirrors backend schedule.py. The parity block
// replays the Python implementation's recorded outputs (tests/fixtures/).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cronValid, cronNext, cronLabels, timeAt, tzSuffix, fmtMoment, timeLabels,
  nextTriggerShort, type TriggerLike,
} from '../src/cron'
import fixture from '../../tests/fixtures/cron_parity.json'

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z')

describe('cronValid', () => {
  it('rejects wrong field counts', () => {
    expect(cronValid('* * * *')).toBe(false)
    expect(cronValid('* * * * * *')).toBe(false)
    expect(cronValid('')).toBe(false)
    expect(cronValid('   ')).toBe(false)
  })
  it('accepts tab-separated 5 fields', () => {
    expect(cronValid('0\t12\t*\t*\t*')).toBe(true)
  })
  it('accepts lists, ranges, and steps', () => {
    expect(cronValid('0,30 8,20 * * *')).toBe(true)
    expect(cronValid('0 9-17 * * 1-5')).toBe(true)
    expect(cronValid('*/15 * * * *')).toBe(true)
    expect(cronValid('*/1 * * * *')).toBe(true)
    expect(cronValid('0-59 * * * *')).toBe(true)
  })
  it('rejects malformed steps and ranges', () => {
    expect(cronValid('5/ * * * *')).toBe(false)
    expect(cronValid('*/0 * * * *')).toBe(false)
    expect(cronValid('1-2-3 * * * *')).toBe(false)
  })
  it('rejects out-of-range values per field', () => {
    expect(cronValid('60 * * * *')).toBe(false)
    expect(cronValid('* 24 * * *')).toBe(false)
    expect(cronValid('* * 0 * *')).toBe(false)
    expect(cronValid('* * 32 * *')).toBe(false)
    expect(cronValid('* * * 0 *')).toBe(false)
    expect(cronValid('* * * 13 *')).toBe(false)
    expect(cronValid('* * * * 7')).toBe(false)
  })
})

describe('cronNext', () => {
  it('is strictly after: a match at `after` itself is skipped', () => {
    const d = cronNext('0 12 * * *', new Date('2026-07-20T12:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-21T12:00:00Z')
  })
  it('a match one minute later is taken', () => {
    const d = cronNext('0 12 * * *', new Date('2026-07-20T11:59:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-20T12:00:00Z')
  })
  it('Vixie rule: dom and dow both restricted → either matches', () => {
    // Friday Jul 24 (dow 5) fires before the 13th (dom).
    const d = cronNext('0 12 13 * 5', new Date('2026-07-20T00:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-24T12:00:00Z')
  })
  it('unsatisfiable Feb 30 → null', () => {
    expect(cronNext('0 0 30 2 *', new Date('2026-07-20T00:00:00Z'), 'UTC')).toBeNull()
  })
  it('leap day found in the next leap year', () => {
    const d = cronNext('0 0 29 2 *', new Date('2026-07-20T00:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2028-02-29T00:00:00Z')
  })
  it('invalid expression → null', () => {
    expect(cronNext('bogus', new Date(), 'UTC')).toBeNull()
    expect(cronNext('* * * *', new Date(), 'UTC')).toBeNull()
  })
})

describe('parity with the Python backend (tests/fixtures/cron_parity.json)', () => {
  describe('next', () => {
    for (const c of fixture.next) {
      it(`${c.expr} · ${c.tz} · after ${c.after_utc}`, () => {
        const d = cronNext(c.expr, new Date(c.after_utc), c.tz)
        if (c.next_utc === null) expect(d).toBeNull()
        else expect(d && iso(d)).toBe(c.next_utc)
      })
    }
  })
  describe('labels', () => {
    for (const c of fixture.labels) {
      it(`${JSON.stringify(c.expr)} · ${c.tz ?? 'local'}`, () => {
        const got = cronLabels(c.expr, c.tz ?? undefined)
        expect(got.label).toBe(c.label)
        expect(got.short).toBe(c.short)
      })
    }
  })
})

describe('timeAt', () => {
  it('no tz reads the wall clock as local time', () => {
    const d = timeAt('2026-07-20T09:30')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(20)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
  })
  it('tz reads the wall clock in that zone', () => {
    const d = timeAt('2026-07-20T09:30', 'Asia/Tokyo')
    expect(iso(d)).toBe('2026-07-20T00:30:00Z')
  })
  it('"T" and space separators are equivalent', () => {
    const a = timeAt('2026-07-20T09:30', 'UTC')
    const b = timeAt('2026-07-20 09:30', 'UTC')
    expect(iso(a)).toBe('2026-07-20T09:30:00Z')
    expect(iso(b)).toBe('2026-07-20T09:30:00Z')
  })
  it('invalid string → NaN Date, with and without tz', () => {
    expect(Number.isNaN(timeAt('not a date').getTime())).toBe(true)
    expect(Number.isNaN(timeAt('not a date', 'UTC').getTime())).toBe(true)
  })
})

describe('tzSuffix', () => {
  it('undefined → empty', () => {
    expect(tzSuffix(undefined)).toBe('')
  })
  it('last IANA segment, underscores → spaces', () => {
    expect(tzSuffix('Asia/Tokyo')).toBe(' (Tokyo)')
    expect(tzSuffix('America/Argentina/Buenos_Aires')).toBe(' (Buenos Aires)')
  })
})

describe('fmtMoment / timeLabels', () => {
  it('midnight is 12 AM, noon is 12 PM', () => {
    expect(fmtMoment(new Date(2026, 6, 20, 0, 5))).toBe('Jul 20, 12:05 AM')
    expect(fmtMoment(new Date(2026, 6, 20, 12, 0))).toBe('Jul 20, 12:00 PM')
  })
  it('minutes are zero-padded', () => {
    expect(fmtMoment(new Date(2026, 6, 20, 15, 7))).toBe('Jul 20, 3:07 PM')
  })
  it('timeLabels renders the wall clock as written, with tz suffix', () => {
    const { label, short } = timeLabels('2026-07-20T15:00', 'Asia/Tokyo')
    expect(label).toBe('Once at Jul 20, 3:00 PM (Tokyo)')
    expect(short).toBe('Once Jul 20 15:00 (Tokyo)')
  })
})

describe('nextTriggerShort', () => {
  afterEach(() => vi.useRealTimers())
  const pin = (isoNow: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(isoNow))
  }

  it('off triggers, app_start, past, and invalid times are all skipped', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expr: '0 12 * * *', tz: 'UTC', off: true },
      { kind: 'app_start' },
      { kind: 'time', at: '2020-01-01T00:00', tz: 'UTC' },
      { kind: 'time', at: 'garbage' },
    ]
    expect(nextTriggerShort(triggers)).toBeNull()
    expect(nextTriggerShort([])).toBeNull()
  })

  it('earliest enabled occurrence wins (one-shot before cron)', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expr: '0 12 * * *', tz: 'UTC' },          // 12:00Z today
      { kind: 'time', at: '2026-07-20T06:00', tz: 'UTC' },      // 06:00Z today
      { kind: 'app_start' },
    ]
    expect(nextTriggerShort(triggers)).toBe('Once Jul 20 6:00 (UTC)')
  })

  it('cron wins when the one-shot is later', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expr: '0 12 * * *', tz: 'UTC' },          // 12:00Z today
      { kind: 'time', at: '2026-07-21T06:00', tz: 'UTC' },      // tomorrow
    ]
    expect(nextTriggerShort(triggers)).toBe('Daily 12:00 (UTC)')
  })
})
