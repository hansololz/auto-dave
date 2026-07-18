// API shapes (§4 field names, served by §19).

export type Status =
  | 'queued' | 'executing' | 'succeeded' | 'failed' | 'cancelled'
  | 'skipped' | 'reused' | 'interrupted' | 'none'

export interface ParamDef {
  name: string
  kind: 'toggle' | 'list' | 'kv' | 'number' | 'text'
  label: string
  help: string
  validate?: boolean
  min?: number
  placeholder?: string
  default?: unknown
  // merged current values:
  on?: boolean
  lines?: string[]
  rows?: { k: string; v: string }[]
  value?: string | number
}

export interface SpecBlock { k: 'h1' | 'h2' | 'p' | 'li'; text: string }

export interface Step {
  name: string
  desc: string
  code: string
  file?: string
  agent?: boolean
  agentId?: string | null
  why?: string
}

// §6.2 declared package — a pinned pip requirement plus the module it provides.
// `status` is transient (§19 check/install responses and §8 draft payloads);
// 'installing' exists client-side only, while an install call is in flight.
// `latest` is transient too (§19 outdated response) — present only when a
// newer installable version exists; drives the §11 update badge.
export interface PackageDep {
  pip: string
  import: string
  status?: 'installed' | 'missing' | 'failed' | 'installing'
  error?: string
  latest?: string
}

export interface ResultValue { name: string; value: string | string[] }
export interface ResultFile { name: string; size: string }

export interface ExecResult {
  chip?: string
  chipStatus?: 'changes' | 'ok' | 'attention'
  chips?: string[]
  values?: ResultValue[]
  files?: ResultFile[]
  path?: string
  when?: string
}

export interface VersionInfo {
  v: number
  when: string
  note: string | null
  spec: SpecBlock[]
  instr: string
  steps: Step[]
  params: ParamDef[]
  packages: PackageDep[]
  // §4.4 draft-only: the editor's grant selections; absent on real versions
  stepAgents?: string[]
  allowedSecrets?: string[]
}

// §4.3 trigger — cron or one-shot time; discord/imessage/pubsub are reserved
// kinds the API refuses to store ("coming soon").
export interface Trigger {
  id: string
  kind: 'cron' | 'time'
  off: boolean
  expr?: string   // cron: 5-field expression, local time
  at?: string     // time: local wall-clock ISO timestamp
  label: string   // backend-derived display strings (§4.3)
  short: string
}

// The shape drafts carry (§8) and PATCH sends — no id/labels yet.
export interface DraftTrigger {
  kind: 'cron' | 'time'
  off: boolean
  expr?: string
  at?: string
}

export interface Auto {
  id: string
  name: string
  desc: string
  version: number
  triggers: Trigger[]        // §4.3 — user-owned, never versioned
  triggerChip: string        // one → its short label · several → "N triggers" · none → "No triggers"
  triggersOff: boolean       // nonempty list, every trigger off (drives the OFF tag)
  nextAt: number | null      // epoch ms of the next enabled occurrence
  instr: string
  lastStatus: Status
  live: string | null
  resultChip: string | null
  resultStatus: 'changes' | 'ok' | 'attention' | null
  lastExecLabel: string
  agentId: string | null
  stepAgents: string[]
  allowedSecrets: string[]
  snapshotSettings: SnapshotSettings // §6.3 automatic-snapshot toggles
  specMeta: string
  latest?: (ExecResult & { execId: string; when: string }) | null
  params?: ParamDef[]
  memory?: { size: string; updated: string; path?: string }
  snapshots?: MemorySnapshot[] // §6.3 — newest-first
  steps?: Step[]
  spec?: SpecBlock[]
  packages?: PackageDep[]    // §6.2 — the current version's declared packages
  versions?: VersionInfo[]
  draft?: VersionInfo | null
}

// §6.3 automatic-snapshot toggles — one per automatic reason, all default true
export interface SnapshotSettings {
  preVersion: boolean
  preClear: boolean
  preRestore: boolean
}

// §6.3 memory snapshot (API shape, §4.1)
export interface MemorySnapshot {
  id: string
  name: string | null
  reason: 'manual' | 'pre-clear' | 'pre-version' | 'pre-restore'
  when: string
  version: string
  size: string
  files: number
}

export interface ExecStep { name: string; status: Status; dur: string }

export interface Exec {
  id: string
  autoId: string
  autoName: string
  autoDeleted: boolean
  ver: string
  status: Status
  trigger: 'Manual' | 'Schedule' | 'Menu bar'
  dur: string
  started: string
  startedMs: number
  note: string | null
  // §4.5 failure diagnostics — failed executions only
  error: { step: string | null; message: string; reason: string | null } | null
  steps: ExecStep[]
  logs?: { t: string; k: 'sys' | 'out' | 'wrn' | 'err'; text: string }[]
  result?: ExecResult | null
  redact?: string | null
  params?: ParamDef[]
}

export interface Agent {
  id: string
  name: string | null
  desc?: string
  harness: 'Claude Code' | 'Gemini CLI' | 'Codex' | 'OpenCode' | 'Ollama'
  mode: 'default' | 'ollama'
  // null unless mode is 'ollama' — the harness uses its own configured model
  model: string | null
  default?: boolean
  usedBy?: string[]
}

export interface SecretMeta { name: string; desc: string; usedBy: string }

export interface Settings {
  login: boolean
  mbIcon: boolean
  notif: 'attention' | 'all'
  days: number
  keepForever: boolean
  devMode: boolean
  dataPath: string
  dataSize: string
  appPath?: string
}

// §8: `edit` jobs return only `spec`; create/sync jobs return the full payload.
export interface DraftPayload {
  name?: string | null
  desc?: string
  note?: string
  params?: ParamDef[]
  packages?: PackageDep[]    // §6.2 — statuses attached after the install stage
  steps?: Step[]
  spec: SpecBlock[] | null
  instr?: string | null
  triggers?: DraftTrigger[]  // §8: cron-only in drafts
  secretRefs?: string[]
  // §4.4: grant selections carried by the draft snapshot
  stepAgents?: string[]
  allowedSecrets?: string[]
}

// §8 blocker envelope entry — a `blocked` job's payload.
export interface Blocker {
  reason: string
  fix: string
  details?: string
}

export interface DraftJob {
  id: string
  status: 'building' | 'done' | 'failed' | 'cancelled' | 'blocked'
  stage: string | null
  error: string | null
  errorDetail?: string[]
  // On a create job, `draft.spec` carries call 1's validated spec as soon as
  // the spec call completes (§11 drafting-on-Review renders it mid-job); a
  // blocked steps call keeps it there so the Blocker modal can amend it.
  draft: DraftPayload | null
  mode: 'create' | 'edit' | 'sync'
  // blocked jobs only: which call blocked
  blockedAt?: 'spec' | 'steps'
  blockers?: Blocker[]
}

export interface StateSnapshot {
  version: string
  autos: Auto[]
  execs: Exec[]
  agents: Agent[]
  secrets: SecretMeta[]
  settings: Settings
}
