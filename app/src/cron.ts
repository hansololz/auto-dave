// §4.3 trigger math for the renderer — mirrors backend schedule.py for the
// Add-trigger live preview, draft-trigger chips, and "next trigger" labels.
// The API remains the authority: every stored trigger is validated server-side.

export interface TriggerLike {
  kind: 'cron' | 'time'
  expr?: string
  at?: string
  off?: boolean
}

const DOW_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
const SEARCH_DAYS = 366 * 5

interface Field { vals: Set<number>; star: boolean }

function parseField(text: string, lo: number, hi: number): Field | null {
  if (!text) return null
  const vals = new Set<number>()
  for (const item of text.split(',')) {
    const [body, stepS, extra] = item.split('/')
    if (extra !== undefined) return null
    let step = 1
    if (stepS !== undefined) {
      if (!/^\d+$/.test(stepS) || Number(stepS) < 1) return null
      step = Number(stepS)
    }
    let a: number
    let b: number
    if (body === '*') {
      a = lo; b = hi
    } else if (/^\d+-\d+$/.test(body)) {
      const [aS, bS] = body.split('-')
      a = Number(aS); b = Number(bS)
    } else if (/^\d+$/.test(body)) {
      a = Number(body); b = a
    } else {
      return null
    }
    if (a < lo || b > hi || a > b) return null
    for (let v = a; v <= b; v += step) vals.add(v)
  }
  return { vals, star: text === '*' }
}

function parseCron(expr: string): Field[] | null {
  const parts = (expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5 || parts[0] === '') return null
  const out: Field[] = []
  for (let i = 0; i < 5; i++) {
    const f = parseField(parts[i], RANGES[i][0], RANGES[i][1])
    if (!f) return null
    out.push(f)
  }
  return out
}

export function cronValid(expr: string): boolean {
  return parseCron(expr) !== null
}

/** Next match strictly after `after` (default now); null if invalid/unsatisfiable. */
export function cronNext(expr: string, after?: Date): Date | null {
  const f = parseCron(expr)
  if (!f) return null
  const [mins, hours, doms, months, dows] = f
  const t = new Date(after ?? new Date())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const hhmm: [number, number][] = []
  for (const hh of [...hours.vals].sort((x, y) => x - y)) {
    for (const mm of [...mins.vals].sort((x, y) => x - y)) hhmm.push([hh, mm])
  }
  const day = new Date(t)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < SEARCH_DAYS; i++) {
    if (months.vals.has(day.getMonth() + 1)) {
      const specDow = day.getDay() // JS getDay(): Sun=0 — already the spec convention
      // Vixie rule: both dom and dow restricted → a date matching either fires.
      const dayOk = dows.star ? doms.vals.has(day.getDate())
        : doms.star ? dows.vals.has(specDow)
        : doms.vals.has(day.getDate()) || dows.vals.has(specDow)
      if (dayOk) {
        const sameDay = day.getFullYear() === t.getFullYear() && day.getMonth() === t.getMonth() && day.getDate() === t.getDate()
        for (const [hh, mm] of hhmm) {
          const cand = new Date(day)
          cand.setHours(hh, mm, 0, 0)
          if (!sameDay || cand >= t) return cand
        }
      }
    }
    day.setDate(day.getDate() + 1)
  }
  return null
}

const hm = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`

/** §4.3 humanized labels — exactly two simple shapes get words. */
export function cronLabels(expr: string): { label: string; short: string } {
  const p = expr.trim().split(/\s+/)
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') {
    const t = hm(Number(p[1]), Number(p[0]))
    if (p[4] === '*') return { label: `Daily at ${t}`, short: `Daily ${t}` }
    if (/^\d$/.test(p[4]) && Number(p[4]) <= 6) {
      const d = Number(p[4])
      return { label: `${DOW_LONG[d]} at ${t}`, short: `${DOW_SHORT[d]} ${t}` }
    }
  }
  return { label: expr.trim(), short: expr.trim() }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jul 20, 3:00 PM" — the Add-trigger "next:" preview and one-shot labels. */
export function fmtMoment(d: Date): string {
  const ampm = `${(d.getHours() % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${ampm}`
}

export function timeLabels(at: string): { label: string; short: string } {
  const d = new Date(at)
  return {
    label: `Once at ${fmtMoment(d)}`,
    short: `Once ${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d.getHours(), d.getMinutes())}`,
  }
}

export function triggerShort(t: TriggerLike): string {
  return t.kind === 'cron' ? cronLabels(t.expr ?? '').short : timeLabels(t.at ?? '').short
}

/** Short label of the soonest enabled trigger (§4.3 nextAt's trigger), null when none. */
export function nextTriggerShort(triggers: TriggerLike[]): string | null {
  let best: { at: Date; t: TriggerLike } | null = null
  for (const t of triggers) {
    if (t.off) continue
    const at = t.kind === 'cron' ? cronNext(t.expr ?? '') : new Date(t.at ?? '')
    if (!at || Number.isNaN(at.getTime()) || at <= new Date()) continue
    if (!best || at < best.at) best = { at, t }
  }
  return best ? triggerShort(best.t) : null
}
