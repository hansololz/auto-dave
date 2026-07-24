// Secrets page (§4.8, §12): Keychain-backed name/value pairs — values are
// never fetched back; rows only ever show a mask.
import React, { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { SecretMeta } from '../types'
import { BtnGhost, BtnPrimary, ConfirmModal, Eyebrow, MiniBadge, Modal, PageTitle } from '../ui'

const MASK = '••••••••••••'
const NAME_RE = /^[A-Z][A-Z0-9_]*$/

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', color: 'var(--text)',
  font: `400 12.5px var(--mono)`, padding: '9px 11px',
}

type ModalState = { mode: 'add' } | { mode: 'edit'; name: string; desc: string; usedBy: string } | null

function SecretModal({ modal, onClose }: { modal: NonNullable<ModalState>; onClose: () => void }) {
  const { showToast } = useStore()
  const isAdd = modal.mode === 'add'
  const [name, setName] = useState(isAdd ? '' : modal.name)
  const [desc, setDesc] = useState(isAdd ? '' : modal.desc)
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)

  return (
    <Modal onClose={onClose} width={440} cardStyle={{ padding: '22px 24px' }}>
      {(close) => {
        const save = async () => {
          if (isAdd) {
            if (!name) { showToast('Give the secret a name.'); return }
            if (!NAME_RE.test(name)) { showToast('Secret names must start with a letter — A–Z, 0–9 and _ only.'); return }
          }
          try {
            // §4.8: a blank value on edit keeps the stored one (description-only
            // update); a blank value on add creates a placeholder (set: false).
            await api.putSecret(name, value, desc)
            close()
            showToast(isAdd
              ? (value ? 'Saved to your Keychain.' : 'Saved — add the value before an automation needs it.')
              : 'Secret updated.')
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
              {isAdd ? 'New secret' : 'Edit secret'}
            </h2>
            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 18px' }}>
              {isAdd
                ? 'A password or API key your automations use by name — the value itself never appears in a script or a log.'
                : 'A new value is used from the next execution onward — leave the value blank to keep the current one.'}
            </p>
            <Eyebrow style={{ margin: '0 0 6px' }}>NAME</Eyebrow>
            {isAdd ? (
              <input
                className="ad-input"
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
                border: '1px solid var(--hairline)', borderRadius: 7, padding: '9px 11px',
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
            <Eyebrow style={{ margin: '16px 0 6px' }}>DESCRIPTION · OPTIONAL</Eyebrow>
            <input
              className="ad-input"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              placeholder="What this secret is for — helps the drafting agent pick the right secret"
              style={inputStyle}
            />
            <Eyebrow style={{ margin: '16px 0 6px' }}>VALUE</Eyebrow>
            <div style={{ position: 'relative' }}>
              <textarea
                className="ad-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onValueKeyDown}
                autoFocus={!isAdd}
                spellCheck={false}
                rows={3}
                placeholder={isAdd
                  ? 'Paste the password or API key — or leave blank to add the value later'
                  : 'Leave blank to keep the current value'}
                style={{
                  ...inputStyle, padding: '9px 62px 9px 11px', resize: 'vertical', minHeight: 60,
                  WebkitTextSecurity: show ? 'none' : 'disc',
                } as React.CSSProperties}
              />
              <button
                className="ad-btn-text"
                onClick={() => setShow(!show)}
                style={{
                  position: 'absolute', right: 5, top: 6, borderRadius: 5,
                  fontWeight: 500, fontSize: 11, padding: '4px 9px',
                }}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 22 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)', marginRight: 'auto' }}>
                <i className="fa-solid fa-lock" style={{ fontSize: 10 }} />
                Stored in your Mac’s Keychain
              </span>
              <BtnGhost onClick={close}>Cancel</BtnGhost>
              <BtnPrimary onClick={() => { void save() }}>
                {isAdd ? 'Save to Keychain' : 'Save changes'}
              </BtnPrimary>
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
      <PageTitle
        style={{ marginBottom: 6 }}
        right={<BtnPrimary onClick={() => setModal({ mode: 'add' })}>Add secret</BtnPrimary>}
      >
        Secrets
      </PageTitle>
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
          <BtnPrimary onClick={() => setModal({ mode: 'add' })}>Add your first secret</BtnPrimary>
        </div>
      ) : (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
          padding: '10px 18px', borderBottom: '1px solid var(--hairline)',
        }}>
          <Eyebrow style={{ fontSize: 9.5 }}>NAME</Eyebrow>
          <Eyebrow style={{ fontSize: 9.5 }}>USED BY</Eyebrow>
          <Eyebrow style={{ fontSize: 9.5 }}>VALUE</Eyebrow>
          <span />
        </div>
        {secrets.map((s) => (
          <div
            key={s.name}
            style={{
              display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
              padding: '12px 18px', borderBottom: '1px solid var(--hairline-dim)', alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{s.name}</span>
                {!s.set && (
                  <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>
                )}
              </div>
              {s.desc && (
                <div style={{
                  fontSize: 11.5, color: 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.desc}
                </div>
              )}
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{s.usedBy}</span>
            <span style={{
              font: `400 12px var(--mono)`,
              color: s.set ? 'var(--text-muted)' : 'var(--text-faint)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {s.set ? MASK : '—'}
            </span>
            <div style={{ display: 'flex', gap: 4, justifySelf: 'end', alignItems: 'center' }}>
              <button
                className="ad-btn-text"
                onClick={() => setModal({ mode: 'edit', name: s.name, desc: s.desc, usedBy: s.usedBy })}
                title="Edit"
                style={{
                  borderRadius: 6, width: 26, height: 26, display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: 0,
                }}
              >
                <i className="fa-solid fa-pen" style={{ fontSize: 11 }} />
              </button>
              <button
                className="ad-btn-text"
                onClick={() => setDel(s)}
                title="Delete"
                style={{
                  borderRadius: 6, width: 26, height: 26, display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: 0,
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
                <p style={{ color: 'var(--red-text)', margin: '8px 0 0' }}>
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
