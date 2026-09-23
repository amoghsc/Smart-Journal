import { useEffect, useRef, useState } from 'react'
import { Check, FolderInput, Globe, Lock } from 'lucide-react'
import { useStore } from '../lib/store'
import type { Page, Vault } from '../lib/types'

interface Props {
  page: Page
  /** Other notes in this vault that link here (their links become plain text after a move). */
  linkedFrom: number
  onMoved: () => void
}

/** Dropdown to move a note to another vault: pick, then confirm inline. */
export function MoveToVault({ page, linkedFrom, onMoved }: Props) {
  const { vaults, movePage } = useStore()
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<Vault | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const toggle = () => { setOpen(o => !o); setPick(null); setErr(null) }

  const move = async () => {
    if (!pick) return
    setBusy(true); setErr(null)
    try { await movePage(page.id, pick.id); setOpen(false); onMoved() }
    catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="move" ref={box}>
      <button className={'icon-btn' + (open ? ' on' : '')} title="Move to another vault" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <FolderInput size={16} />
      </button>
      {open && (
        <div className="move-menu" role="menu">
          <div className="move-head">Move to vault</div>
          {vaults.map(v => {
            const current = v.id === page.vault_id
            return (
              <button key={v.id} role="menuitemradio" aria-checked={current}
                className={'move-row' + (current ? ' current' : '') + (pick?.id === v.id ? ' picked' : '')}
                disabled={current || busy} onClick={() => { setPick(v); setErr(null) }}>
                {v.kind === 'public' ? <Globe size={13} /> : <Lock size={13} />}
                <span className="move-name">{v.name}</span>
                {current && <Check size={13} />}
              </button>
            )
          })}
          {pick && (
            <div className="move-confirm">
              {pick.kind === 'public' && <p>Notes in a public vault can be published.</p>}
              {linkedFrom > 0 && <p>{linkedFrom} {linkedFrom === 1 ? 'link' : 'links'} to this note here will become plain text.</p>}
              <button className="btn small primary" onClick={move} disabled={busy}>{busy ? 'Moving…' : `Move to ${pick.name}`}</button>
            </div>
          )}
          {err && <p className="move-err">{err}</p>}
        </div>
      )}
    </div>
  )
}
