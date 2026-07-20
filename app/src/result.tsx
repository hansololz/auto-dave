// Result section (§7): a collapsible stack of result views — the Summary view
// (result.yaml values), one view per renderable file (.md markdown, .html in a
// sandboxed iframe, images inline), and a collapsible FILES footer with a
// "Show in Finder" button. Collapse state is component state only (§7: per
// session, never persisted).
import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './api'
import { Eyebrow, resultChipColors, Spinner } from './ui'
import type { ResultFile, ResultValue, ExecResult, SpecBlock } from './types'

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
        className="ad-btn-text"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
          padding: '13px 18px', cursor: 'pointer', background: 'none',
        }}
      >
        <i
          className={open ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'}
          style={{ fontSize: 10, width: 10, flex: 'none' }}
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

// ---------- markdown (§4.5 shared renderer) ----------

export function Markdown({ text }: { text: string }) {
  // GFM via react-markdown + remark-gfm; output is React elements (never
  // injected HTML). Styling lives in tokens.css under .ad-md.
  return (
    <div className="ad-copy ad-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          table: ({ node: _, ...props }) => <div className="ad-md-tablewrap"><table {...props} /></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Spec cards (create flow + automation page): SpecBlock[] → markdown, rendered
// by the same shared component as every other markdown surface.
export function SpecMarkdown({ blocks }: { blocks: SpecBlock[] }) {
  const md = blocks.map((b, i) => {
    const line = b.k === 'h1' ? '# ' + b.text : b.k === 'h2' ? '## ' + b.text : b.k === 'li' ? '- ' + b.text : b.text
    // adjacent li stay one list; everything else separates into its own block
    return (i === 0 ? '' : b.k === 'li' && blocks[i - 1].k === 'li' ? '\n' : '\n\n') + line
  }).join('')
  return <Markdown text={md} />
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
          className="ad-btn-text"
          onClick={() => setOpen(!open)}
          style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', background: 'none', padding: 0 }}
        >
          <i
            className={open ? 'fa-solid fa-caret-down' : 'fa-solid fa-caret-right'}
            style={{ fontSize: 10, width: 10 }}
          />
          <Eyebrow style={{ color: 'var(--text-faint)' }}>{label}</Eyebrow>
        </button>
        {chip && (
          <span style={{
            display: 'inline-flex', padding: '3px 10px', borderRadius: 6, fontFamily: 'var(--mono)',
            fontWeight: 600, fontSize: 11.5, letterSpacing: '.03em', background: bg, color: c,
          }}>
            {chip}
          </span>
        )}
        {(result.chips ?? []).filter((t) => t !== chip).map((t) => (
          <span key={t} style={{
            display: 'inline-flex', padding: '3px 9px', borderRadius: 6, fontFamily: 'var(--mono)',
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
