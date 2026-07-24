// §4.3 trigger math for the renderer — mirrors backend schedule.py for the
// Add-trigger live preview, draft-trigger chips, and "next trigger" labels.
// The API remains the authority: every stored trigger is validated server-side.

export interface TriggerLike {
  kind: 'cron' | 'time' | 'app_start'
  expr?: string
  at?: string
  tz?: string
  off?: boolean
}

// ---------- §4.3 `tz`: wall clock in the trigger's zone ----------

/** §4.3 label suffix — the zone's city: last IANA segment, _ → space. */
export function tzSuffix(tz?: string): string {
  return tz ? ` (${tz.split('/').pop()!.replace(/_/g, ' ')})` : ''
}

// Wall clocks are carried as "wall ms": the wall-clock fields UTC-encoded via
// Date.UTC. UTC has no DST, so adding days or setting hours on wall ms never
// shifts the components — mirroring the backend's naive-datetime math
// (schedule.py). Building candidates as real local Dates instead (setHours on
// a local Date) silently normalizes DST-nonexistent times and corrupts the
// wall clock, even for other zones' triggers on a *local* transition day.

/** Wall clock of instant `d` in `tz`, as wall ms. */
function wallMsInZone(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
}

/** Wall clock of instant `d` in the local zone, as wall ms. */
function wallMsLocal(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
}

/** Wall ms → the real instant (two-pass offset fixpoint for `tz`). Ambiguous
 * fall-back wall times resolve to the earlier instant, like the backend's
 * fold=0 `_to_local`. */
function wallMsToDate(wallMs: number, tz?: string): Date {
  const w = new Date(wallMs)
  if (!tz) return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes())
  let utc = wallMs
  for (let i = 0; i < 2; i++) utc += wallMs - wallMsInZone(new Date(utc), tz)
  if (wallMsInZone(new Date(utc - 3600000), tz) === wallMs) utc -= 3600000
  return new Date(utc)
}

/** A one-shot's real moment: `at`'s wall clock read in `tz` (local when absent). */
export function timeAt(at: string, tz?: string): Date {
  const wall = new Date(at)
  if (!tz || Number.isNaN(wall.getTime())) return wall
  // Read the wall fields from the string itself — parsing through a local
  // Date would normalize an `at` that is DST-nonexistent locally.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(at)
  return wallMsToDate(m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : wallMsLocal(wall), tz)
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

/** Next match strictly after `after` (default now), as a real local-time Date;
 * with `tz` the expression reads as the zone's wall clock. Null if invalid/unsatisfiable. */
export function cronNext(expr: string, after?: Date, tz?: string): Date | null {
  const f = parseCron(expr)
  if (!f) return null
  const [mins, hours, doms, months, dows] = f
  const now = after ?? new Date()
  let t = tz ? wallMsInZone(now, tz) : wallMsLocal(now)
  t -= t % 60000
  t += 60000 // strictly after
  const hhmm: [number, number][] = []
  for (const hh of [...hours.vals].sort((x, y) => x - y)) {
    for (const mm of [...mins.vals].sort((x, y) => x - y)) hhmm.push([hh, mm])
  }
  const tDay = new Date(t)
  let day = Date.UTC(tDay.getUTCFullYear(), tDay.getUTCMonth(), tDay.getUTCDate())
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const d = new Date(day)
    if (months.vals.has(d.getUTCMonth() + 1)) {
      const specDow = d.getUTCDay() // Sun=0 — already the spec convention
      // Vixie rule: both dom and dow restricted → a date matching either fires.
      const dayOk = dows.star ? doms.vals.has(d.getUTCDate())
        : doms.star ? dows.vals.has(specDow)
        : doms.vals.has(d.getUTCDate()) || dows.vals.has(specDow)
      if (dayOk) {
        // A candidate on a later day is always > t, so one compare covers
        // both the same-day floor and later days (as in the backend).
        for (const [hh, mm] of hhmm) {
          const cand = day + (hh * 60 + mm) * 60000
          if (cand >= t) return wallMsToDate(cand, tz)
        }
      }
    }
    day += 86400000
  }
  return null
}

const hm = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`

/** §4.3 humanized labels — exactly two simple shapes get words. */
export function cronLabels(expr: string, tz?: string): { label: string; short: string } {
  const sfx = tzSuffix(tz)
  const p = expr.trim().split(/\s+/)
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') {
    const t = hm(Number(p[1]), Number(p[0]))
    if (p[4] === '*') return { label: `Daily at ${t}${sfx}`, short: `Daily ${t}${sfx}` }
    if (/^\d$/.test(p[4]) && Number(p[4]) <= 6) {
      const d = Number(p[4])
      return { label: `${DOW_LONG[d]} at ${t}${sfx}`, short: `${DOW_SHORT[d]} ${t}${sfx}` }
    }
  }
  return { label: expr.trim() + sfx, short: expr.trim() + sfx }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jul 20, 3:00 PM" — the Add-trigger "next:" preview and one-shot labels. */
export function fmtMoment(d: Date): string {
  const ampm = `${(d.getHours() % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${ampm}`
}

export function timeLabels(at: string, tz?: string): { label: string; short: string } {
  const d = new Date(at) // the wall clock as written — labels show the trigger zone's time
  const sfx = tzSuffix(tz)
  return {
    label: `Once at ${fmtMoment(d)}${sfx}`,
    short: `Once ${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d.getHours(), d.getMinutes())}${sfx}`,
  }
}

export function triggerShort(t: TriggerLike): string {
  if (t.kind === 'app_start') return 'App start'
  return t.kind === 'cron' ? cronLabels(t.expr ?? '', t.tz).short : timeLabels(t.at ?? '', t.tz).short
}

/** Short label of the soonest enabled trigger (§4.3 nextAt's trigger), null when none. */
export function nextTriggerShort(triggers: TriggerLike[]): string | null {
  let best: { at: Date; t: TriggerLike } | null = null
  for (const t of triggers) {
    if (t.off || t.kind === 'app_start') continue // §4.3: no computable next occurrence
    const at = t.kind === 'cron' ? cronNext(t.expr ?? '', undefined, t.tz) : timeAt(t.at ?? '', t.tz)
    if (!at || Number.isNaN(at.getTime()) || at <= new Date()) continue
    if (!best || at < best.at) best = { at, t }
  }
  return best ? triggerShort(best.t) : null
}
