import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Globe, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { RenameVaultDialog } from './RenameVaultDialog'
import { useStore } from '../lib/store'
import type { Vault, VaultKind } from '../lib/types'

/** Vault picker at the top of the sidebar; public vaults carry a globe. */
export function VaultSwitcher() {
  const { vaults, vault, setVault, createVault, deleteVault, pagesIn } = useStore()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<VaultKind>('private')
  const box = useRef<HTMLDivElement>(null)
  // inline rename: which vault is being edited, and the confirmed request
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [renaming, setRenaming] = useState<{ vault: Vault; name: string } | null>(null)

  const startRename = (v: Vault) => { setEditing(v.id); setDraftName(v.name) }
  const submitRename = (v: Vault) => {
    const next = draftName.replace(/\s+/g, ' ').trim()
    setEditing(null)
    if (!next || next === v.name) return
    setOpen(false)
    setRenaming({ vault: v, name: next })
  }

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setAdding(false); setEditing(null) } }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const add = async () => {
    if (!name.trim()) return
    try {
      const v = await createVault(name.trim(), kind)
      setVault(v.id); setName(''); setAdding(false); setOpen(false)
    } catch (e) { alert((e as Error).message) }
  }

  const remove = async (id: string, vname: string) => {
    const n = pagesIn(id).length
    if (!confirm(`Delete the vault “${vname}” and its ${n} ${n === 1 ? 'note' : 'notes'}? This cannot be undone.`)) return
    try { await deleteVault(id) } catch (e) { alert((e as Error).message) }
  }

  if (!vault) return null
  return (
    <div className="vault" ref={box}>
      <button className="vault-btn" onClick={() => setOpen(o => !o)} title="Switch vault">
        {vault.kind === 'public' ? <Globe size={14} /> : <Lock size={14} />}
        <span className="vault-name">{vault.name}</span>
        <ChevronDown size={14} className="vault-caret" />
      </button>

      {open && (
        <div className="vault-menu">
          {vaults.map(v => editing === v.id ? (
            <div key={v.id} className="vault-row editing">
              {v.kind === 'public' ? <Globe size={13} /> : <Lock size={13} />}
              <input autoFocus value={draftName} aria-label="Vault name" onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitRename(v); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) } }}
                onBlur={() => submitRename(v)} />
            </div>
          ) : (
            <div key={v.id} className={'vault-row' + (v.id === vault.id ? ' on' : '')}>
              <button className="vault-pick" onClick={() => { setVault(v.id); setOpen(false) }}>
                {v.kind === 'public' ? <Globe size={13} /> : <Lock size={13} />}
                <span className="vault-name">{v.name}</span>
                <span className="vault-count">{pagesIn(v.id).length}</span>
                {v.id === vault.id && <Check size={13} />}
              </button>
              <button className="vault-del" title="Rename vault" onClick={() => startRename(v)}><Pencil size={13} /></button>
              {vaults.length > 1 && <button className="vault-del danger" title="Delete vault" onClick={() => remove(v.id, v.name)}><Trash2 size={13} /></button>}
            </div>
          ))}

          {adding ? (
            <div className="vault-add">
              <input autoFocus value={name} placeholder="Vault name" onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false) }} />
              <div className="seg wide">
                <button className={kind === 'private' ? 'on' : ''} onClick={() => setKind('private')}><Lock size={12} /> Private</button>
                <button className={kind === 'public' ? 'on' : ''} onClick={() => setKind('public')}><Globe size={12} /> Public</button>
              </div>
              <p className="muted small">{kind === 'public'
                ? 'Notes here can be exported as a website. Nothing is published until you press Publish.'
                : 'Notes here can never be published.'}</p>
              <button className="btn primary small" onClick={add}>Create vault</button>
            </div>
          ) : (
            <button className="vault-new" onClick={() => setAdding(true)}><Plus size={14} /> New vault</button>
          )}
        </div>
      )}
      {renaming && <RenameVaultDialog vault={renaming.vault} name={renaming.name} onClose={() => setRenaming(null)} />}
    </div>
  )
}
