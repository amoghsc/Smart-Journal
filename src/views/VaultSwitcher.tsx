import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Globe, Import, Laptop, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { MoveToMacDialog } from '../components/MoveToMacDialog'
import { folderSupported, macVault, pickFolder } from '../lib/macVault'
import { ImportDialog } from '../components/ImportDialog'
import { RenameVaultDialog } from './RenameVaultDialog'
import { useStore } from '../lib/store'
import type { Vault, VaultKind } from '../lib/types'

const macVaultFolder = (id: string) => macVault(id)?.folderName

/** Vault picker at the top of the sidebar; public vaults carry a globe, vaults on this Mac a laptop. */
export function VaultSwitcher() {
  const { vaults, vault, setVault, createVault, deleteVault, pagesIn, updateVault, macStatus } = useStore()
  // a new vault lives on this Mac unless this browser can't keep a folder
  const [where, setWhere] = useState<'mac' | 'cloud'>(() => (folderSupported() ? 'mac' : 'cloud'))
  const [moving, setMoving] = useState(false)
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
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
      // (the folder is asked for straight from the click)
      const dir = where === 'mac' ? await pickFolder() : undefined
      if (where === 'mac' && !dir) return
      const v = await createVault(name.trim(), kind, dir ?? undefined)
      setVault(v.id); setName(''); setAdding(false); setOpen(false)
    } catch (e) { alert((e as Error).message) }
  }

  const remove = async (id: string, vname: string) => {
    const n = pagesIn(id).length
    const onMac = vaults.find(v => v.id === id)?.storage === 'mac'
    if (!confirm(onMac
      ? `Remove the vault “${vname}” from Smart Journal? Its folder and ${n} note ${n === 1 ? 'file stays' : 'files stay'} on your Mac, untouched.`
      : `Delete the vault “${vname}” and its ${n} ${n === 1 ? 'note' : 'notes'}? This cannot be undone.`)) return
    try { await deleteVault(id) } catch (e) { alert((e as Error).message) }
  }

  if (!vault) return null
  return (
    <div className="vault" ref={box}>
      <button className="vault-btn" onClick={() => setOpen(o => !o)} title="Switch vault">
        <span className="vault-label">Vault</span>
        {vault.kind === 'public' ? <Globe size={14} /> : <Lock size={14} />}
        <span className="vault-name">{vault.name}</span>
        {vault.storage === 'mac' && <Laptop size={13} className="vault-mac" aria-label="On this Mac" />}
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
                {v.storage === 'mac' && <Laptop size={12} className="vault-mac" aria-label="On this Mac" />}
                <span className="vault-count">{v.storage === 'mac' && macStatus[v.id] !== 'ready' ? '' : pagesIn(v.id).length}</span>
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
              <div className="seg wide">
                <button className={where === 'mac' ? 'on' : ''} onClick={() => setWhere('mac')} disabled={!folderSupported()} title={folderSupported() ? '' : 'This browser can’t keep a folder (Chrome, Comet, Edge or Arc can)'}><Laptop size={12} /> On this Mac</button>
                <button className={where === 'cloud' ? 'on' : ''} onClick={() => setWhere('cloud')}><Cloud size={12} /> Cloud</button>
              </div>
              <p className="muted small">{where === 'mac'
                ? 'You’ll pick a folder: each note is a Markdown file in it, and nothing goes to the cloud. Pick an empty folder, or one with Markdown notes to open them here.'
                : 'Notes are kept in your Smart Journal account, on every device you sign in on.'}</p>
              <button className="btn primary small" onClick={add}>{where === 'mac' ? 'Choose folder…' : 'Create vault'}</button>
            </div>
          ) : (
            <>
              {/* this vault: where it lives, and what may leave it */}
              <div className="vault-here">
                <div className="vault-where">
                  {vault.storage === 'mac'
                    ? <><Laptop size={13} /> On this Mac{macVaultFolder(vault.id) ? <> · <b>{macVaultFolder(vault.id)}</b></> : ''}</>
                    : <><Cloud size={13} /> In the cloud</>}
                  {vault.storage !== 'mac' && folderSupported() && <button className="link" onClick={() => { setMoving(true); setOpen(false) }}>Move to this Mac…</button>}
                </div>
                <label className="vault-switch"><input type="checkbox" checked={!vault.ai_off} onChange={e => updateVault(vault.id, { ai_off: !e.target.checked }).catch(err => alert((err as Error).message))} />
                  AI tools <span className="muted">(selected text goes to Gemini)</span></label>
                <label className="vault-switch"><input type="checkbox" checked={!vault.link_lookup_off} onChange={e => updateVault(vault.id, { link_lookup_off: !e.target.checked }).catch(err => alert((err as Error).message))} />
                  Link titles <span className="muted">(a pasted link’s address is looked up)</span></label>
              </div>
              <button className="vault-new" onClick={() => setAdding(true)}><Plus size={14} /> New vault</button>
              <button className="vault-new import" onClick={() => { setImporting(true); setOpen(false) }}><Import size={14} /> Import from Obsidian, Logseq or Roam…</button>
            </>
          )}
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {moving && <MoveToMacDialog onClose={() => setMoving(false)} />}
      {renaming && <RenameVaultDialog vault={renaming.vault} name={renaming.name} onClose={() => setRenaming(null)} />}
    </div>
  )
}
