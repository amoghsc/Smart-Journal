import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Globe, Lock, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { extractLinks } from '../lib/html'
import { isDailyTitle, normTitle, prettyDate } from '../lib/links'
import type { Page, Vault } from '../lib/types'

interface Props {
  page: Page
  /** Switch to `vault` and show `title` there. */
  onOpenCopy: (vaultId: string, title: string) => void
}

const label = (t: string) => isDailyTitle(t) ? prettyDate(t, true) : t

/** Dropdown of vaults → review dialog → copy. The note stays in its current vault. */
export function CopyToVault({ page, onOpenCopy }: Props) {
  const { vaults } = useStore()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<Vault | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="move" ref={box}>
      <button className={'icon-btn' + (open ? ' on' : '')} title="Copy to another vault" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Copy size={16} />
      </button>
      {open && (
        <div className="move-menu" role="menu">
          <div className="move-head">Copy to vault</div>
          {vaults.map(v => {
            const current = v.id === page.vault_id
            return (
              <button key={v.id} role="menuitem" className={'move-row' + (current ? ' current' : '')} disabled={current}
                onClick={() => { setTarget(v); setOpen(false) }}>
                {v.kind === 'public' ? <Globe size={13} /> : <Lock size={13} />}
                <span className="move-name">{v.name}</span>
                {current && <Check size={13} />}
              </button>
            )
          })}
        </div>
      )}
      {target && <CopyDialog page={page} target={target} onClose={() => setTarget(null)} onOpenCopy={onOpenCopy} />}
    </div>
  )
}

interface Row { page: Page; existing: Page | undefined }

function CopyDialog({ page, target, onClose, onOpenCopy }: { page: Page; target: Vault; onClose: () => void; onOpenCopy: Props['onOpenCopy'] }) {
  const { vaults, pagesIn, copyPages } = useStore()
  const source = vaults.find(v => v.id === page.vault_id)

  // the note, and the notes it links to in its own vault
  const { main, linked } = useMemo(() => {
    const here = new Map(pagesIn(page.vault_id).filter(p => !p.local && p.kind !== 'canvas').map(p => [normTitle(p.title), p]))
    const there = new Map(pagesIn(target.id).filter(p => !p.local).map(p => [normTitle(p.title), p]))
    const rows: Row[] = []
    for (const t of extractLinks(page.body)) {
      const p = here.get(t)
      if (p && p.id !== page.id) rows.push({ page: p, existing: there.get(t) })
    }
    rows.sort((a, b) => a.page.title.localeCompare(b.page.title))
    return { main: { page, existing: there.get(normTitle(page.title)) } as Row, linked: rows }
  }, [page, target.id, pagesIn])

  // new notes are ticked; ones already in the target are left alone unless ticked
  const [picked, setPicked] = useState<Set<string>>(() => new Set(linked.filter(r => !r.existing).map(r => r.page.id)))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const toggle = (id: string) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const count = 1 + picked.size
  const replacing = [main, ...linked.filter(r => picked.has(r.page.id))].filter(r => r.existing).length

  const copy = async () => {
    setBusy(true); setErr(null)
    try { setDone(await copyPages([page.id, ...picked], target.id)) }
    catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  const status = (r: Row) => r.existing ? <span className="copy-status update">replaces the copy there</span> : <span className="copy-status">new</span>

  return (
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal copy" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Copy size={15} /> Copy to “{target.name}”</h2>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="copy-body">
          <p className="muted small">
            The note stays in “{source?.name}”; an independent copy is made in “{target.name}”.
            {target.kind === 'public' && ' Notes there can be published.'}
          </p>

          <ul className="copy-list">
            <li className="copy-main">
              <input type="checkbox" checked disabled aria-label="This note" />
              <span className="copy-title">{label(page.title)}</span>
              {status(main)}
            </li>
          </ul>

          {linked.length > 0 ? <>
            <h3 className="copy-sub">Notes it links to</h3>
            <ul className="copy-list">
              {linked.map(r => (
                <li key={r.page.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(r.page.id)} onChange={() => toggle(r.page.id)} disabled={busy || done !== null} />
                    <span className="copy-title">{label(r.page.title)}</span>
                    {picked.has(r.page.id) ? status(r) : <span className="copy-status">stays behind</span>}
                  </label>
                </li>
              ))}
            </ul>
            <p className="muted small">Links to notes left behind stay in the text; in a published site they show as plain words.</p>
          </> : <p className="muted small">This note doesn’t link to any other notes.</p>}
        </div>

        <div className="modal-foot">
          <div className="pub-status">
            {err && <span className="err-text">{err}</span>}
            {done !== null && <span className="pub-done">Copied {done} {done === 1 ? 'note' : 'notes'} to “{target.name}”.</span>}
            {done === null && !err && replacing > 0 && <span className="muted small">{replacing} existing {replacing === 1 ? 'copy is' : 'copies are'} replaced.</span>}
          </div>
          <div className="pub-actions">
            {done === null ? <>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={copy} disabled={busy}>{busy ? 'Copying…' : `Copy ${count} ${count === 1 ? 'note' : 'notes'}`}</button>
            </> : <>
              <button className="btn" onClick={onClose}>Stay here</button>
              <button className="btn primary" onClick={() => { onClose(); onOpenCopy(target.id, page.title) }}>Open in “{target.name}”</button>
            </>}
          </div>
        </div>
      </div>
    </div>
  )
}
