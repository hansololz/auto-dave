// Unit tests for the exported pure helpers in src/pages/CreateFlow.tsx.
// The module graph pulls in store/api/ui/result — api is mocked so importing
// never opens sockets or fetches.
import { describe, expect, it, vi } from 'vitest'
import type { Blocker, DraftTrigger, SpecBlock, Step } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {},
}))

import {
  specToText, textToSpec, amendSpec, stepSecretNames, secretRefsOf,
  instrToMd, mergeDraftTriggers,
} from '../src/pages/CreateFlow'

const step = (over: Partial<Step> = {}): Step =>
  ({ name: 's', desc: '', code: '', ...over })

describe('specToText / textToSpec', () => {
  const blocks: SpecBlock[] = [
    { k: 'h1', text: 'Title' },
    { k: 'h2', text: 'Section' },
    { k: 'li', text: 'item' },
    { k: 'p', text: 'paragraph' },
  ]

  it('serializes with "# ", "## ", "- " prefixes and plain paragraphs', () => {
    expect(specToText(blocks)).toBe('# Title\n## Section\n- item\nparagraph')
  })
  it('round-trips stably', () => {
    expect(textToSpec(specToText(blocks))).toEqual(blocks)
  })
  it('drops blank lines and trims', () => {
    expect(textToSpec('a\n\n   \nb')).toEqual([
      { k: 'p', text: 'a' }, { k: 'p', text: 'b' },
    ])
  })
  it('"## " beats "# "; a hash without a space is a paragraph', () => {
    expect(textToSpec('## X')).toEqual([{ k: 'h2', text: 'X' }])
    expect(textToSpec('# X')).toEqual([{ k: 'h1', text: 'X' }])
    expect(textToSpec('- X')).toEqual([{ k: 'li', text: 'X' }])
    expect(textToSpec('#X')).toEqual([{ k: 'p', text: '#X' }])
  })
})

describe('stepSecretNames', () => {
  it('unions declared secrets with secrets.NAME code refs, deduped', () => {
    const s = step({
      secrets: ['ALPHA'],
      code: 'x = secrets.BETA + secrets.ALPHA\ny = secrets.BETA',
    })
    expect(stepSecretNames(s)).toEqual(['ALPHA', 'BETA'])
  })
  it('lowercase secrets.foo is NOT matched', () => {
    expect(stepSecretNames(step({ code: 'y = secrets.foo' }))).toEqual([])
  })
  it('empty step → empty list', () => {
    expect(stepSecretNames(step())).toEqual([])
  })
})

describe('secretRefsOf', () => {
  it('aggregates name → step indices', () => {
    const steps = [
      step({ code: 'a = secrets.API_KEY' }),
      step({ code: 'b = secrets.API_KEY + secrets.DB_PASS' }),
      step({ code: 'plain' }),
    ]
    expect(secretRefsOf(steps)).toEqual([
      { name: 'API_KEY', steps: [0, 1] },
      { name: 'DB_PASS', steps: [1] },
    ])
  })
})

describe('instrToMd', () => {
  it('bare prose lines become bullets; block syntax stays untouched', () => {
    const input = [
      'Rule one',
      '- already bullet',
      '* star bullet',
      '# heading',
      '1. ordered',
      '| a | b |',
      '',
      'Rule two',
    ].join('\n')
    expect(instrToMd(input)).toBe([
      '- Rule one',
      '- already bullet',
      '* star bullet',
      '# heading',
      '1. ordered',
      '| a | b |',
      '',
      '- Rule two',
    ].join('\n'))
  })
  it('fenced code passes through untouched (fence state tracked)', () => {
    const input = [
      'Before fence',
      '```py',
      'plain code line',
      '```',
      'after fence',
    ].join('\n')
    expect(instrToMd(input)).toBe([
      '- Before fence',
      '```py',
      'plain code line',
      '```',
      '- after fence',
    ].join('\n'))
  })
})

describe('amendSpec', () => {
  const blockers: Blocker[] = [
    { reason: ' Site needs login ', fix: ' Use the saved cookie ' },
    { reason: 'Rate limited', fix: 'Retry with backoff' },
  ]
  const lines: SpecBlock[] = [
    { k: 'li', text: 'Site needs login — Use the saved cookie' },
    { k: 'li', text: 'Rate limited — Retry with backoff' },
  ]

  it('appends the section when missing', () => {
    const spec: SpecBlock[] = [{ k: 'h1', text: 'T' }, { k: 'p', text: 'body' }]
    expect(amendSpec(spec, blockers)).toEqual([
      ...spec,
      { k: 'h2', text: 'Constraints & resolutions' },
      ...lines,
    ])
  })
  it('inserts at the end of an existing mid-document section, before the next heading', () => {
    const spec: SpecBlock[] = [
      { k: 'h1', text: 'T' },
      { k: 'h2', text: 'constraints & RESOLUTIONS' }, // case-insensitive match
      { k: 'li', text: 'old — resolution' },
      { k: 'h2', text: 'Next section' },
      { k: 'p', text: 'tail' },
    ]
    expect(amendSpec(spec, blockers)).toEqual([
      spec[0], spec[1], spec[2],
      ...lines,
      spec[3], spec[4],
    ])
  })
  it('section at the end of the document gets the lines appended', () => {
    const spec: SpecBlock[] = [
      { k: 'h1', text: 'T' },
      { k: 'h2', text: 'Constraints & resolutions' },
      { k: 'li', text: 'old — resolution' },
    ]
    expect(amendSpec(spec, blockers)).toEqual([...spec, ...lines])
  })
})

describe('mergeDraftTriggers', () => {
  const cron = (over: Partial<DraftTrigger>): DraftTrigger =>
    ({ kind: 'cron', off: false, ...over })

  it('drafted cron matching an existing expr+tz keeps the existing entry (id and off)', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expr: '0 8 * * *', tz: 'UTC', off: true }),
      { id: 't1', kind: 'time', off: false, at: '2026-01-01T00:00' },
    ]
    const drafted: DraftTrigger[] = [cron({ expr: '0 8 * * *', tz: 'UTC' })]
    expect(mergeDraftTriggers(cur, drafted)).toEqual([
      cur[0],       // id c1 and off:true preserved
      cur[1],       // non-cron passes through unchanged
    ])
  })

  it('tz must match too — undefined tz equals absent, not a different zone', () => {
    const cur: DraftTrigger[] = [cron({ id: 'c1', expr: '0 8 * * *', tz: 'UTC' })]
    const merged = mergeDraftTriggers(cur, [cron({ expr: '0 8 * * *' })]) // no tz → no match
    expect(merged).toEqual([{ kind: 'cron', off: false, expr: '0 8 * * *' }])
  })

  it('duplicate identical exprs consume distinct existing entries once each', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expr: '0 8 * * *', off: true }),
      cron({ id: 'c2', expr: '0 8 * * *', off: false }),
    ]
    const drafted: DraftTrigger[] = [
      cron({ expr: '0 8 * * *' }),
      cron({ expr: '0 8 * * *' }),
    ]
    const merged = mergeDraftTriggers(cur, drafted)
    expect(merged.map((t) => t.id)).toEqual(['c1', 'c2'])
  })

  it('unmatched drafted cron becomes a new entry with off:false', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expr: '0 8 * * *' }),
      { id: 'a1', kind: 'app_start', off: false },
    ]
    const drafted: DraftTrigger[] = [cron({ expr: '30 9 * * 1', off: true })]
    const merged = mergeDraftTriggers(cur, drafted)
    expect(merged).toEqual([
      { kind: 'cron', off: false, expr: '30 9 * * 1' }, // off forced to false
      cur[1],                                            // app_start survives
    ])
    // the unmatched existing cron is replaced by the drafted schedule
    expect(merged.some((t) => t.id === 'c1')).toBe(false)
  })
})
