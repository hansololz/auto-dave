// Unit tests for the pure helpers in src/ui.tsx. No component rendering:
// highlightPython isn't exported, so it is exercised through PyCode called as
// a plain function — the returned element's children are the token nodes.
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextIn, paramSummary, validUrl, badgeOf, resultChipColors, P, PyCode,
} from '../src/ui'
import type { ParamDef } from '../src/types'

describe('nextIn', () => {
  afterEach(() => vi.useRealTimers())
  const now = new Date('2026-07-20T00:00:00Z').getTime()
  const pin = () => { vi.useFakeTimers(); vi.setSystemTime(now) }

  it('null nextAt → empty string', () => {
    expect(nextIn({ nextAt: null })).toBe('')
  })
  it('past nextAt clamps to one minute', () => {
    pin()
    expect(nextIn({ nextAt: now - 5 * 60000 })).toBe('0h 1m')
  })
  it('exact day boundary → "Xd Xh" form', () => {
    pin()
    expect(nextIn({ nextAt: now + 1440 * 60000 })).toBe('1d 0h')
    expect(nextIn({ nextAt: now + 25 * 3600000 })).toBe('1d 1h')
  })
  it('sub-day → "Xh Xm" form', () => {
    pin()
    expect(nextIn({ nextAt: now + 90 * 60000 })).toBe('1h 30m')
    expect(nextIn({ nextAt: now + 60000 })).toBe('0h 1m')
  })
})

describe('paramSummary', () => {
  const p = (over: Partial<ParamDef>): ParamDef =>
    ({ name: 'p', kind: 'text', label: 'P', help: '', ...over } as ParamDef)

  it('toggle: on beats default; default true fills in', () => {
    expect(paramSummary(p({ kind: 'toggle', on: true }))).toBe('On')
    expect(paramSummary(p({ kind: 'toggle', on: false, default: true }))).toBe('Off')
    expect(paramSummary(p({ kind: 'toggle', default: true }))).toBe('On')
    expect(paramSummary(p({ kind: 'toggle', default: false }))).toBe('Off')
  })
  it('list with validate counts valid URLs only', () => {
    expect(paramSummary(p({ kind: 'list', validate: true, lines: ['http://a.com', 'nope', '', '  '] }))).toBe('1 links')
  })
  it('list without validate counts non-empty entries', () => {
    expect(paramSummary(p({ kind: 'list', lines: ['a', '', '  ', 'b'] }))).toBe('2 entries')
  })
  it('list falls back to array default', () => {
    expect(paramSummary(p({ kind: 'list', default: ['a', 'b'] }))).toBe('2 entries')
  })
  it('kv counts rows, with default fallback', () => {
    expect(paramSummary(p({ kind: 'kv', rows: [{ k: 'a', v: '1' }, { k: 'b', v: '2' }, { k: 'c', v: '3' }] }))).toBe('3 entries')
    expect(paramSummary(p({ kind: 'kv', default: [{ k: 'a', v: '1' }] }))).toBe('1 entries')
    expect(paramSummary(p({ kind: 'kv' }))).toBe('0 entries')
  })
  it('number: value → default → min → 0 chain', () => {
    expect(paramSummary(p({ kind: 'number', value: 5, default: 3, min: 1 }))).toBe('5')
    expect(paramSummary(p({ kind: 'number', default: 3, min: 1 }))).toBe('3')
    expect(paramSummary(p({ kind: 'number', min: 2 }))).toBe('2')
    expect(paramSummary(p({ kind: 'number' }))).toBe('0')
  })
  it('text: value → default → "Not set"', () => {
    expect(paramSummary(p({ kind: 'text', value: 'x', default: 'd' }))).toBe('x')
    expect(paramSummary(p({ kind: 'text', default: 'd' }))).toBe('d')
    expect(paramSummary(p({ kind: 'text' }))).toBe('Not set')
    expect(paramSummary(p({ kind: 'text', value: '' }))).toBe('Not set')
  })
})

describe('validUrl', () => {
  it('accepts http and https with a dot', () => {
    expect(validUrl('http://a.com')).toBe(true)
    expect(validUrl('https://sub.example.io/path?x=1')).toBe(true)
    expect(validUrl('  https://a.com  ')).toBe(true)
  })
  it('rejects no scheme and no dot', () => {
    expect(validUrl('a.com')).toBe(false)
    expect(validUrl('ftp://a.com')).toBe(false)
    expect(validUrl('http://localhost')).toBe(false)
    expect(validUrl('')).toBe(false)
  })
})

describe('badgeOf', () => {
  it('maps every known status', () => {
    expect(badgeOf('queued')).toEqual({ label: 'Queued', c: P.gray, bg: P.grayBg })
    expect(badgeOf('executing')).toEqual({ label: 'Executing', c: P.cyan, bg: P.cyanBg })
    expect(badgeOf('succeeded')).toEqual({ label: 'Succeeded', c: P.green, bg: P.greenBg })
    expect(badgeOf('failed')).toEqual({ label: 'Failed', c: P.red, bg: P.redBg })
    expect(badgeOf('cancelled')).toEqual({ label: 'Cancelled', c: P.gray, bg: P.grayBg })
    expect(badgeOf('skipped')).toEqual({ label: 'Skipped', c: P.gray, bg: P.grayBg })
    expect(badgeOf('interrupted')).toEqual({ label: 'Interrupted', c: P.magenta, bg: P.magentaBg })
    expect(badgeOf('none')).toEqual({ label: 'Not executed yet', c: P.gray, bg: P.grayBg })
  })
  it('unknown status falls back to `none`', () => {
    expect(badgeOf('totally-unknown')).toEqual({ label: 'Not executed yet', c: P.gray, bg: P.grayBg })
  })
})

describe('resultChipColors', () => {
  it('changes → accent, attention → orange, everything else → green', () => {
    expect(resultChipColors('changes')).toEqual({ c: P.accent, bg: P.accentBg })
    expect(resultChipColors('attention')).toEqual({ c: P.orange, bg: P.orangeBg })
    expect(resultChipColors('ok')).toEqual({ c: P.green, bg: P.greenBg })
    expect(resultChipColors(null)).toEqual({ c: P.green, bg: P.greenBg })
    expect(resultChipColors(undefined)).toEqual({ c: P.green, bg: P.greenBg })
  })
})

// ---------- highlightPython (via PyCode called as a plain function) ----------

const COLOR = {
  keyword: '#c792ea', const: '#f78c6c', string: '#c3e88d', number: '#f78c6c',
  comment: '#5c6b7a', builtin: '#82aaff', call: '#82aaff', def: '#ffcb6b',
  decorator: '#ffcb6b',
}

interface Tok { text: string; color?: string; italic?: boolean }
function tokens(code: string): Tok[] {
  const el = PyCode({ code }) as React.ReactElement
  const children = el.props.children as React.ReactNode[]
  return children.map((n) => {
    if (typeof n === 'string') return { text: n }
    const e = n as React.ReactElement
    const style = (e.props.style ?? {}) as React.CSSProperties
    return { text: String(e.props.children), color: style.color, italic: style.fontStyle === 'italic' }
  })
}
const tok = (ts: Tok[], text: string) => ts.find((t) => t.text === text)

describe('highlightPython', () => {
  const code = [
    '@app.route',
    'def foo(x):',
    '    # note',
    "    return bar(1.5) + f\"hi {x}\" and print(len('a')) or True",
  ].join('\n')

  it('classifies keywords, def names, calls, builtins, strings, numbers, comments, decorators', () => {
    const ts = tokens(code)
    expect(tok(ts, '@app.route')?.color).toBe(COLOR.decorator)
    expect(tok(ts, 'def')?.color).toBe(COLOR.keyword)
    expect(tok(ts, 'return')?.color).toBe(COLOR.keyword)
    expect(tok(ts, 'and')?.color).toBe(COLOR.keyword)
    expect(tok(ts, 'or')?.color).toBe(COLOR.keyword)
    expect(tok(ts, 'foo')?.color).toBe(COLOR.def)          // def-name beats call lookahead
    expect(tok(ts, 'bar')?.color).toBe(COLOR.call)         // followed by "("
    expect(tok(ts, 'print')?.color).toBe(COLOR.builtin)
    expect(tok(ts, 'len')?.color).toBe(COLOR.builtin)
    expect(tok(ts, '1.5')?.color).toBe(COLOR.number)
    expect(tok(ts, 'f"hi {x}"')?.color).toBe(COLOR.string) // f-string is one string token
    expect(tok(ts, "'a'")?.color).toBe(COLOR.string)
    expect(tok(ts, 'True')?.color).toBe(COLOR.const)
    const comment = tok(ts, '# note')
    expect(comment?.color).toBe(COLOR.comment)
    expect(comment?.italic).toBe(true)
    // plain identifier: parameter x has no color (plain string node)
    expect(tok(ts, 'x')?.color).toBeUndefined()
  })

  it('call lookahead requires the very next char to be "("', () => {
    const ts = tokens('foo (1)')
    expect(tok(ts, 'foo')?.color).toBeUndefined()
  })

  it('unterminated string does not throw and still colors as string', () => {
    let ts: Tok[] = []
    expect(() => { ts = tokens('x = "abc') }).not.toThrow()
    expect(tok(ts, '"abc')?.color).toBe(COLOR.string)
  })

  it('triple-quoted string spans newlines as one token', () => {
    const ts = tokens("s = '''a\nb'''")
    expect(tok(ts, "'''a\nb'''")?.color).toBe(COLOR.string)
  })
})
