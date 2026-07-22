// Settings page (§4.9, §12): general toggles, notifications, execution
// history retention, and the on-this-Mac data section.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Eyebrow, PageTitle, RadioRing, Toggle } from '../ui'

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden',
}

const rowTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }
const rowSub: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)', marginTop: 3 }

const pathBox: React.CSSProperties = {
  marginTop: 10, background: 'var(--bg-inset)', border: '1px solid var(--hairline)',
  borderRadius: 7, padding: '7px 11px', font: `400 11.5px var(--mono)`, color: 'var(--text-muted)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

export default function SettingsPage() {
  const { settings, showToast } = useStore()
  const [days, setDays] = useState('')

  useEffect(() => {
    if (settings) setDays(String(settings.days))
  }, [settings?.days])

  if (!settings) return null

  const patch = (p: Record<string, unknown>) => {
    api.patchSettings(p).catch((e: Error) => showToast(e.message))
  }

  const onDaysBlur = () => {
    let n = parseInt(days, 10)
    if (!Number.isFinite(n) || n < 1) n = 90
    setDays(String(n))
    if (n !== settings.days) patch({ days: n })
  }

  // Native folder picker; the chosen directory simply becomes the
  // execution-data location — nothing is moved (§4.9).
  const changeDataPath = async () => {
    try {
      const p = await window.autowright?.pickFolder(settings.dataPath)
      if (!p) return
      await api.setDataPath(p)
      showToast('Execution data location changed.')
    } catch (e) { showToast((e as Error).message) }
  }

  return (
    <div style={{
      maxWidth: 640, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease',
      display: 'flex', flexDirection: 'column', gap: 26,
    }}>
      <PageTitle style={{ marginBottom: 0 }}>Settings</PageTitle>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>GENERAL</Eyebrow>
        <div style={card}>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Launch at login</div>
              <div style={rowSub}>Autowright starts quietly in the menu bar.</div>
            </div>
            <Toggle
              on={settings.login}
              onChange={(v) => { patch({ login: v }); void window.autowright?.setLoginItem(v) }}
            />
          </div>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Show in the menu bar</div>
              <div style={rowSub}>The quickest way to execute an automation.</div>
            </div>
            <Toggle on={settings.mbIcon} onChange={(v) => patch({ mbIcon: v })} />
          </div>
          <div style={{ padding: '15px 20px' }}>
            <div style={rowTitle}>Notify me</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 11 }}>
              {([
                { v: 'attention' as const, label: 'Only when something needs attention' },
                { v: 'all' as const, label: 'After every execution' },
              ]).map((o) => {
                const on = settings.notif === o.v
                return (
                  <button
                    key={o.v}
                    onClick={() => patch({ notif: o.v })}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, background: 'none',
                      border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left',
                    }}
                  >
                    <RadioRing selected={on} size={15} />
                    <span style={{ fontSize: 13, color: on ? 'var(--text)' : 'var(--text-muted)' }}>{o.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>EXECUTION HISTORY</Eyebrow>
        <div style={card}>
          {!settings.keepForever && (
            <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--hairline-dim)', display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1 }}>
                <div style={rowTitle}>Keep executions for</div>
                <div style={rowSub}>Older executions and logs are removed automatically.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                <input
                  className="ad-input"
                  value={days}
                  onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={onDaysBlur}
                  inputMode="numeric"
                  style={{
                    width: 64, color: 'var(--text)', font: `500 12.5px var(--mono)`,
                    textAlign: 'center', padding: '6px 10px',
                  }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>days</span>
              </div>
            </div>
          )}
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Keep execution history forever</div>
              <div style={rowSub}>
                {settings.keepForever
                  ? 'Nothing is ever removed — execution data grows until you clear it yourself.'
                  : 'Turn on to never remove old executions and logs.'}
              </div>
            </div>
            <Toggle on={settings.keepForever} onChange={(v) => patch({ keepForever: v })} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>ON THIS MAC</Eyebrow>
        <div style={card}>
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>Automations &amp; settings</div>
                <div style={rowSub}>Your automations and preferences — small, and always on this Mac.</div>
              </div>
              <button
                className="ad-btn-soft"
                onClick={() => { void window.autowright?.revealPath(settings.appPath ?? '~/Library/Application Support/Autowright') }}
                style={{ flex: 'none' }}
              >
                Show in Finder
              </button>
            </div>
            <div style={pathBox}>{settings.appPath ?? '~/Library/Application Support/Autowright'}</div>
          </div>
          <div style={{ padding: '15px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>
                  Execution data
                  <span style={{ font: `500 11px var(--mono)`, color: 'var(--text-faint)', marginLeft: 6 }}>{settings.dataSize}</span>
                </div>
                <div style={rowSub}>Logs and results from every execution. This is the part that grows.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                <button className="ad-btn-soft" onClick={() => { void changeDataPath() }}>Change</button>
                <button
                  className="ad-btn-soft"
                  onClick={() => { void window.autowright?.revealPath(settings.dataPath) }}
                >
                  Show in Finder
                </button>
              </div>
            </div>
            <div style={pathBox}>{settings.dataPath}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>DEVELOPER</Eyebrow>
        <div style={card}>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Developer mode</div>
              <div style={rowSub}>
                Logs every backend request and every AI request — including the full prompt — to the backend log.
              </div>
            </div>
            <Toggle on={settings.devMode} onChange={(v) => patch({ devMode: v })} />
          </div>
        </div>
      </div>
    </div>
  )
}
