// API shapes (§4 field names, served by §19).

export type Status =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
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

export interface ResultValue { name: string; value: string | string[] }
export interface ResultFile { name: string; size: string }

export interface RunResult {
  status: 'changes' | 'ok' | 'attention'
  chip?: string
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
}

export interface Auto {
  id: string
  name: string
  desc: string
  version: number
  schedule: string
  scheduleShort: string
  hour: number
  min: number
  dow: number | null
  schedOff: boolean
  instr: string
  lastStatus: Status
  live: string | null
  resultChip: string | null
  resultStatus: 'changes' | 'ok' | 'attention' | null
  lastRunLabel: string
  agentId: string | null
  stepAgents: string[]
  allowedSecrets: string[]
  specMeta: string
  latest?: (RunResult & { execId: string; when: string }) | null
  params?: ParamDef[]
  memory?: { size: string; updated: string; path?: string }
  steps?: Step[]
  spec?: SpecBlock[]
  versions?: VersionInfo[]
  draft?: VersionInfo | null
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
  steps: ExecStep[]
  logs?: { t: string; k: 'sys' | 'out' | 'wrn' | 'err'; text: string }[]
  result?: RunResult | null
  redact?: string | null
  params?: ParamDef[]
}

export interface Agent {
  id: string
  name: string | null
  desc?: string
  harness: 'Claude Code' | 'Gemini CLI' | 'Codex' | 'OpenCode' | 'Ollama'
  mode: 'default' | 'ollama'
  model: string
  default?: boolean
  usedBy?: string[]
}

export interface SecretMeta { name: string; usedBy: string }

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
  steps?: Step[]
  spec: SpecBlock[] | null
  instr?: string | null
  schedule?: { hour: number; min: number; dow: number | null }
  secretRefs?: string[]
}

export interface DraftJob {
  id: string
  status: 'building' | 'done' | 'failed' | 'cancelled'
  stage: string | null
  error: string | null
  errorDetail?: string[]
  draft: DraftPayload | null
  mode: 'create' | 'edit' | 'sync'
}

export interface StateSnapshot {
  version: string
  autos: Auto[]
  execs: Exec[]
  agents: Agent[]
  secrets: SecretMeta[]
  settings: Settings
}
