// Secrets page (§4.8, §12): Keychain-backed name/value pairs — values are
// never fetched back; rows only ever show a mask.
import React, { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { SecretMeta } from '../types'
import { ConfirmModal, Modal } from '../ui'

const MASK = '••••••••••••'
const NAME_RE = /^[A-Z][A-Z0-9_]*$/

const labelStyle: React.CSSProperties = {
  display: 'block', font: `600 9.5px var(--mono)`, letterSpacing: '.09em', color: 'var(--text-faint)',
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--bg-card)',
  border: '1px solid rgba(255,255,255,.09)', borderRadius: 7, color: 'var(--text)',
  font: `400 12.5px var(--mono)`, padding: '9px 11px', outline: 'none',
}

type ModalState = { mode: 'add' } | { mode: 'edit'; name: string; usedBy: string } | null

function SecretModal({ modal, onClose }: { modal: NonNullable<ModalState>; onClose: () => void }) {
  const { showToast } = useStore()
  const isAdd = modal.mode === 'add'
  const [name, setName] = useState(isAdd ? '' : modal.name)
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)

  return (
    <Modal onClose={onClose} width={440} cardStyle={{ padding: '22px 24px' }}>
      {(close) => {
        const save = async () => {
          if (isAdd) {
            if (!name || !value) { showToast('Give the secret a name and a value.'); return }
            if (!NAME_RE.test(name)) { showToast('Secret names must start with a letter — A–Z, 0–9 and _ only.'); return }
          } else if (!value) { showToast('Enter a value.'); return }
          try {
            await api.putSecret(name, value)
            close()
            showToast(isAdd ? 'Saved to your Keychain.' : 'Updated in your Keychain.')
          } catch (e) { showToast((e as Error).message) }
        }

        const onKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === 'Enter') void save()
        }

        // Value is a textarea (multi-line values are allowed): Enter inserts a
        // newline, Cmd/Ctrl+Enter saves. Escape is handled by the Modal shell.
        const onValueKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
        }

        return (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: 'var(--text)' }}>
              {isAdd ? 'New secret' : 'Update value'}
            </h2>
            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 18px' }}>
              {isAdd
                ? 'A password or API key your automations use by name — the value itself never appears in a script or a log.'
                : 'The new value is used from the next run onward.'}
            </p>
            <label style={{ ...labelStyle, margin: '0 0 6px' }}>NAME</label>
            {isAdd ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                onKeyDown={onKeyDown}
                autoFocus
                spellCheck={false}
                placeholder="A short name, like MAIL_PASSWORD or CRM_API_KEY"
                style={inputStyle}
              />
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-inset)',
                border: '1px solid rgba(255,255,255,.06)', borderRadius: 7, padding: '9px 11px',
              }}>
                <i className="fa-solid fa-key" style={{ fontSize: 10, color: 'var(--text-faint)' }} />
                <span style={{ font: `500 12.5px var(--mono)`, color: 'var(--text)' }}>{name}</span>
                <span style={{
                  fontSize: 11, color: 'var(--text-faint)', marginLeft: 'auto',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {modal.mode === 'edit' ? modal.usedBy : ''}
                </span>
              </div>
            )}
            <label style={{ ...labelStyle, margin: '16px 0 6px' }}>VALUE</label>
            <div style={{ position: 'relative' }}>
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onValueKeyDown}
                autoFocus={!isAdd}
                spellCheck={false}
                rows={3}
                placeholder="Paste the password or API key — multi-line values are fine"
                style={{
                  ...inputStyle, padding: '9px 62px 9px 11px', resize: 'vertical', minHeight: 60,
                  WebkitTextSecurity: show ? 'none' : 'disc',
                } as React.CSSProperties}
              />
              <button
                onClick={() => setShow(!show)}
                style={{
                  position: 'absolute', right: 5, top: 6,
                  background: 'none', border: 'none', borderRadius: 5, color: 'var(--text-faint)',
                  fontWeight: 500, fontSize: 11, padding: '4px 9px', cursor: 'pointer',
                }}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 22 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)', marginRight: 'auto' }}>
                <i className="fa-solid fa-lock" style={{ fontSize: 10 }} />
                Stored in your Mac’s Keychain
              </span>
              <button
                onClick={close}
                style={{
                  background: 'none', border: '1px solid var(--border-btn)', borderRadius: 7,
                  color: 'var(--text-2)', fontWeight: 500, fontSize: 12.5, padding: '8px 14px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => { void save() }}
                style={{
                  background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 7,
                  fontWeight: 600, fontSize: 12.5, padding: '8px 14px', cursor: 'pointer',
                }}
              >
                {isAdd ? 'Save to Keychain' : 'Update value'}
              </button>
            </div>
          </>
        )
      }}
    </Modal>
  )
}

export default function SecretsPage() {
  const { secrets, showToast } = useStore()
  const [modal, setModal] = useState<ModalState>(null)
  const [del, setDel] = useState<SecretMeta | null>(null)

  const confirmDelete = async () => {
    if (!del) return
    const s = del
    setDel(null)
    try {
      await api.deleteSecret(s.name)
      showToast('Removed from your Keychain.')
    } catch (e) { showToast((e as Error).message) }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px', animation: 'adFadeUp .4s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>Secrets</h1>
        <button
          onClick={() => setModal({ mode: 'add' })}
          style={{
            background: 'rgba(255,255,255,.05)', color: 'var(--text-2em)',
            border: '1px solid var(--border-btn)', borderRadius: 8,
            padding: '8px 13px', fontWeight: 500, fontSize: 12.5, cursor: 'pointer',
          }}
        >
          Add secret
        </button>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 20px' }}>
        Stored in your Mac’s Keychain. Scripts use them by name — the values never appear in logs.
      </p>
      {secrets.length === 0 ? (
        <div style={{
          background: 'var(--bg-card)', border: '1px dashed rgba(255,255,255,.12)', borderRadius: 12,
          padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 12, textAlign: 'center',
        }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', maxWidth: 420 }}>
            No secrets yet. Add a password or API key once, and your automations use it by name — the value never appears in a script or a log.
          </p>
          <button
            onClick={() => setModal({ mode: 'add' })}
            style={{
              background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8,
              padding: '9px 16px', fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}
          >
            Add your first secret
          </button>
        </div>
      ) : (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
          padding: '10px 18px', borderBottom: '1px solid var(--hairline)',
        }}>
          <span style={labelStyle}>NAME</span>
          <span style={labelStyle}>USED BY</span>
          <span style={labelStyle}>VALUE</span>
          <span />
        </div>
        {secrets.map((s) => (
          <div
            key={s.name}
            style={{
              display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
              padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,.04)', alignItems: 'center',
            }}
          >
            <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{s.name}</span>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{s.usedBy}</span>
            <span style={{
              font: `400 12px var(--mono)`, color: 'var(--text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {MASK}
            </span>
            <div style={{ display: 'flex', gap: 4, justifySelf: 'end', alignItems: 'center' }}>
              <button
                onClick={() => setModal({ mode: 'edit', name: s.name, usedBy: s.usedBy })}
                title="Edit"
                style={{
                  background: 'none', border: 'none', borderRadius: 6, color: 'var(--text-faint)',
                  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', padding: 0,
                }}
              >
                <i className="fa-solid fa-pen" style={{ fontSize: 11 }} />
              </button>
              <button
                onClick={() => setDel(s)}
                title="Delete"
                style={{
                  background: 'none', border: 'none', borderRadius: 6, color: 'var(--text-faint)',
                  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', padding: 0,
                }}
              >
                <i className="fa-solid fa-trash-can" style={{ fontSize: 11 }} />
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
      {modal && <SecretModal key={modal.mode === 'edit' ? modal.name : 'add'} modal={modal} onClose={() => setModal(null)} />}
      {del && (
        <ConfirmModal
          title="Delete this secret?"
          body={(
            <>
              <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{del.name}</span>
              {' '}will be removed from your Keychain. This can’t be undone.
              {del.usedBy !== 'Not used yet' && (
                <p style={{ color: 'oklch(0.78 0.15 25)', margin: '8px 0 0' }}>
                  “{del.usedBy}” uses it by name and will stop working.
                </p>
              )}
            </>
          )}
          confirmLabel="Delete secret"
          danger
          onConfirm={() => { void confirmDelete() }}
          onCancel={() => setDel(null)}
        />
      )}
    </div>
  )
}
