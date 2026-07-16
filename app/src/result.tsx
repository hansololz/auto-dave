// Result section (§7): a collapsible stack of result views — the Summary view
// (result.yaml values), one view per renderable file (.md markdown, .html in a
// sandboxed iframe, images inline), and a collapsible FILES footer with a
// "Show in Finder" button. Collapse state is component state only (§7: per
// session, never persisted).
import React, { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { Eyebrow, resultChipColors, Spinner } from './ui'
import type { ResultFile, ResultValue, ExecResult } from './types'

const MD_EXT = ['md', 'markdown']
const HTML_EXT = ['html', 'htm']
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']

function ext(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

function fileKind(name: string): 'md' | 'html' | 'img' | null {
  const e = ext(name)
  if (MD_EXT.includes(e)) return 'md'
  if (HTML_EXT.includes(e)) return 'html'
  if (IMG_EXT.includes(e)) return 'img'
  return null
}

const KIND_LABEL = { md: 'markdown', html: 'web page', img: 'image' } as const

// ---------- collapsible view card ----------

function ViewCard({ title, kind, meta, mono = true, children }: {
  title: string; kind?: string; meta?: string; mono?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
          padding: '12px 18px', cursor: 'pointer', background: 'none',
        }}
      >
        <i
          className={open ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'}
          style={{ fontSize: 10, color: 'var(--text-faint)', width: 10, flex: 'none' }}
        />
        <span style={{
          fontFamily: mono ? 'var(--mono)' : undefined, fontSize: mono ? 12.5 : 13,
          fontWeight: 600, color: 'var(--text)',
        }}>
          {title}
        </span>
        {kind && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)',
            border: '1px solid rgba(255,255,255,.09)', borderRadius: 6, padding: '2px 8px',
          }}>
            {kind}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {meta && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faintest)' }}>{meta}</span>}
      </button>
      {open && children}
    </div>
  )
}

// ---------- Summary view (result.yaml values) ----------

function SummaryView({ values, measure }: { values: ResultValue[]; measure: number }) {
  return (
    <ViewCard title="Summary" kind="values" meta={`${values.length} value${values.length === 1 ? '' : 's'}`} mono={false}>
      <div className="ad-copy" style={{ padding: '0 18px 6px' }}>
        {values.map((v, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '180px 1fr', gap: 18, padding: '11px 0',
            borderTop: i > 0 ? '1px solid var(--hairline)' : 'none', maxWidth: measure,
          }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.55, overflowWrap: 'break-word' }}>
              {v.name}
            </span>
            {Array.isArray(v.value) ? (
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {v.value.map((t, j) => (
                  <li key={j} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2emx)', display: 'flex', gap: 9 }}>
                    <span style={{ color: 'var(--text-faint)', fontWeight: 600, flex: 'none' }}>•</span>{t}
                  </li>
                ))}
              </ul>
            ) : (
              <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2emx)', whiteSpace: 'pre-wrap' }}>
                {v.value}
              </span>
            )}
          </div>
        ))}
      </div>
    </ViewCard>
  )
}

// ---------- markdown (result.md) ----------

function mdInline(s: string, keyBase: string): React.ReactNode[] {
  // links / code / bold / italic — enough for result files, nothing more.
  const out: React.ReactNode[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const key = `${keyBase}-${k++}`
    if (m[1] !== undefined) out.push(<a key={key} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>)
    else if (m[3] !== undefined) out.push(<code key={key} style={{ fontFamily: 'var(--mono)', fontSize: '.92em', background: 'rgba(255,255,255,.06)', borderRadius: 4, padding: '1px 5px' }}>{m[3]}</code>)
    else if (m[4] !== undefined) out.push(<strong key={key} style={{ fontWeight: 600, color: 'var(--text)' }}>{m[4]}</strong>)
    else out.push(<em key={key}>{m[5]}</em>)
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function MdTable({ lines, keyBase }: { lines: string[]; keyBase: string }) {
  const parse = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  const header = parse(lines[0])
  const rows = lines.slice(2).map(parse)
  const cols = `repeat(${header.length}, auto)`
  return (
    <div style={{ margin: '4px -18px', borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)', overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '9px 18px', borderBottom: '1px solid var(--hairline)', background: 'var(--bg-inset)' }}>
        {header.map((h, i) => <Eyebrow key={i} style={{ fontSize: 9.5 }}>{h.toUpperCase()}</Eyebrow>)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '10px 18px', alignItems: 'center',
          borderBottom: i < rows.length - 1 ? '1px solid var(--hairline)' : 'none',
        }}>
          {header.map((_, j) => (
            <div key={j} style={{ fontSize: 12.5, color: j === 0 ? 'var(--text)' : 'var(--text-2)', fontWeight: j === 0 ? 500 : 400 }}>
              {mdInline(r[j] ?? '', `${keyBase}-${i}-${j}`)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const l = lines[i]
    const key = `b${k++}`
    if (!l.trim()) { i++; continue }
    if (l.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      out.push(
        <pre key={key} style={{
          fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.7, color: 'var(--text-2em)',
          background: 'var(--bg-inset)', border: '1px solid var(--hairline)', borderRadius: 8,
          padding: '10px 14px', overflowX: 'auto',
        }}>{buf.join('\n')}</pre>,
      )
      continue
    }
    if (/^\|.*\|\s*$/.test(l) && /^\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const buf: string[] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++])
      out.push(<MdTable key={key} lines={buf} keyBase={key} />)
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l)
    if (h) {
      const size = [15, 13.5, 12.5][h[1].length - 1]
      out.push(<div key={key} style={{ fontSize: size, fontWeight: 600, color: 'var(--text)', marginTop: k > 1 ? 6 : 0 }}>{mdInline(h[2], key)}</div>)
      i++
      continue
    }
    if (/^[-*]\s+/.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''))
      out.push(
        <ul key={key} style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {buf.map((t, j) => (
            <li key={j} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2emx)', display: 'flex', gap: 9 }}>
              <span style={{ color: 'var(--text-faint)', fontWeight: 600, flex: 'none' }}>•</span>
              <span style={{ minWidth: 0 }}>{mdInline(t, `${key}-${j}`)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }
    if (/^\d+\.\s+/.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ''))
      out.push(
        <ol key={key} style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
          {buf.map((t, j) => (
            <li key={j} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2emx)', display: 'flex', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)', flex: 'none', fontSize: 12, width: 15, textAlign: 'right' }}>{j + 1}.</span>
              <span style={{ minWidth: 0 }}>{mdInline(t, `${key}-${j}`)}</span>
            </li>
          ))}
        </ol>,
      )
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|[-*]\s|\d+\.\s|\||```)/.test(lines[i])) buf.push(lines[i++])
    out.push(<p key={key} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-2em)', textWrap: 'pretty' }}>{mdInline(buf.join(' '), key)}</p>)
  }
  return <div className="ad-copy" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{out}</div>
}

// ---------- file views ----------

// §4.5: sandboxed page — no scripts (sandbox omits allow-scripts), no remote
// loads (CSP), links open outside (allow-popups + base target), app-styled by
// the injected base stylesheet; the page's own inline CSS overrides it.
const HTML_BASE = `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<base target="_blank">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 4px 18px 16px; background: #12151c;
         font: 400 13px/1.6 'IBM Plex Sans', -apple-system, sans-serif; color: #c6cdd6;
         -webkit-font-smoothing: antialiased; }
  h1, h2, h3 { color: #e9ecf1; letter-spacing: -.01em; margin: 14px 0 6px; }
  h1 { font-size: 15px; } h2 { font-size: 13.5px; } h3 { font-size: 12.5px; }
  p { margin: 8px 0; } a { color: oklch(0.74 0.155 52); text-decoration: none; }
  a:hover { color: oklch(0.82 0.14 60); text-decoration: underline; }
  code, pre { font: 400 11.5px/1.7 'IBM Plex Mono', monospace; }
  pre { background: #0d1015; border: 1px solid rgba(255,255,255,.06); border-radius: 8px; padding: 10px 14px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th { font: 600 9.5px 'IBM Plex Mono', monospace; letter-spacing: .09em; text-transform: uppercase;
       color: #67707c; text-align: left; padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,.06); }
  td { font-size: 12.5px; color: #a8b0bc; padding: 10px; border-bottom: 1px solid rgba(255,255,255,.04); }
  td:first-child { color: #e9ecf1; font-weight: 500; }
  img { max-width: 100%; }
</style>
</head>`

function HtmlView({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  return (
    <iframe
      ref={ref}
      title="result page"
      sandbox="allow-same-origin allow-popups"
      srcDoc={HTML_BASE + html}
      onLoad={() => {
        const doc = ref.current?.contentDocument
        if (doc) setHeight(Math.min(720, doc.documentElement.scrollHeight + 4))
      }}
      style={{ width: '100%', height, border: 'none', display: 'block', colorScheme: 'dark' }}
    />
  )
}

function FileView({ execId, file }: { execId: string; file: ResultFile }) {
  const kind = fileKind(file.name)!
  const [text, setText] = useState<string | null>(null)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    let url: string | null = null
    void api.resultFile(execId, file.name)
      .then(async (r) => (kind === 'img' ? URL.createObjectURL(await r.blob()) : r.text()))
      .then((v) => {
        if (dead) { if (kind === 'img') URL.revokeObjectURL(v as string); return }
        if (kind === 'img') { url = v as string; setImgUrl(url) } else setText(v as string)
      })
      .catch((e: Error) => { if (!dead) setErr(e.message) })
    return () => { dead = true; if (url) URL.revokeObjectURL(url) }
  }, [execId, file.name])
  return (
    <ViewCard title={file.name} kind={KIND_LABEL[kind]} meta={file.size}>
      {err ? (
        <div className="ad-copy" style={{ padding: '0 18px 14px', fontSize: 12.5, color: 'var(--text-faint)' }}>Couldn’t load {file.name} — {err}</div>
      ) : kind === 'img' ? (
        imgUrl
          ? <div style={{ padding: '0 18px 16px' }}><img src={imgUrl} alt={file.name} style={{ maxWidth: '100%', borderRadius: 8 }} /></div>
          : <div style={{ padding: '0 18px 16px' }}><Spinner size={14} /></div>
      ) : text === null ? (
        <div style={{ padding: '0 18px 16px' }}><Spinner size={14} /></div>
      ) : kind === 'md' ? (
        <div style={{ padding: '2px 18px 16px' }}><Markdown text={text} /></div>
      ) : (
        <HtmlView html={text} />
      )}
    </ViewCard>
  )
}

// ---------- FILES footer ----------

function FilesFooter({ files, path }: { files: ResultFile[]; path?: string }) {
  return (
    <ViewCard title={`FILES · ${files.length}`} mono>
      <div className="ad-copy" style={{ padding: '0 18px 12px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10,
          borderBottom: '1px solid var(--hairline)',
        }}>
          <span style={{
            flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faintest)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left',
          }}>
            {path ?? ''}
          </span>
          {path && (
            <button
              className="ad-btn-ghost"
              onClick={() => { void window.autodave?.revealPath(path) }}
              style={{ flex: 'none', fontSize: 12 }}
            >
              <i className="fa-solid fa-folder-open" style={{ fontSize: 10 }} /> Show in Finder
            </button>
          )}
        </div>
        {files.map((f, i) => (
          <div key={f.name} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
            borderBottom: i < files.length - 1 ? '1px solid var(--hairline)' : 'none',
          }}>
            <i className="fa-solid fa-file-lines" style={{ fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }} />
            <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2em)', overflowWrap: 'break-word' }}>
              {f.name}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faintest)', flex: 'none' }}>{f.size}</span>
          </div>
        ))}
        {files.length === 0 && (
          <div style={{ padding: '9px 0', fontSize: 12, color: 'var(--text-faint)' }}>No files.</div>
        )}
      </div>
    </ViewCard>
  )
}

// ---------- the section ----------

export function ResultSection({ label, result, execId, measure = 640 }: {
  label: string; result: ExecResult & { when?: string }; execId: string; measure?: number
}) {
  const [open, setOpen] = useState(true)
  const { c, bg } = resultChipColors(result.chipStatus)
  const chip = result.chip
  const values = result.values ?? []
  const files = result.files ?? []
  const renderable = files.filter((f) => fileKind(f.name) !== null)
  const empty = values.length === 0 && files.length === 0
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <button
          onClick={() => setOpen(!open)}
          style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', background: 'none', padding: 0 }}
        >
          <i
            className={open ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'}
            style={{ fontSize: 10, color: 'var(--text-faint)', width: 10 }}
          />
          <Eyebrow style={{ color: 'var(--text-faint)' }}>{label}</Eyebrow>
        </button>
        {chip && (
          <span style={{
            display: 'inline-flex', padding: '3px 10px', borderRadius: 7, fontFamily: 'var(--mono)',
            fontWeight: 600, fontSize: 11.5, letterSpacing: '.03em', background: bg, color: c,
          }}>
            {chip}
          </span>
        )}
        {(result.chips ?? []).filter((t) => t !== chip).map((t) => (
          <span key={t} style={{
            display: 'inline-flex', padding: '3px 9px', borderRadius: 7, fontFamily: 'var(--mono)',
            fontWeight: 500, fontSize: 11, background: 'rgba(255,255,255,.05)',
            border: '1px solid rgba(255,255,255,.07)', color: 'var(--text-2em)',
          }}>
            {t}
          </span>
        ))}
        {result.when && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faintest)' }}>{result.when}</span>
        )}
      </div>
      {open && (
        empty ? (
          <div style={{
            background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)',
            borderRadius: 12, padding: 22, textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)',
          }}>
            The latest execution didn’t produce any result files.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {values.length > 0 && <SummaryView values={values} measure={measure} />}
            {renderable.map((f) => <FileView key={f.name} execId={execId} file={f} />)}
            <FilesFooter files={files} path={result.path} />
          </div>
        )
      )}
    </div>
  )
}
