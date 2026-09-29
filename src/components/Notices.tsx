import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, PartyPopper, X } from 'lucide-react'
import { NOTICE_EVENT, useStore } from '../lib/store'
import { toast } from '../lib/toast'
import type { AppNotice } from '../lib/types'

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

// congratulations are shown once per notice, on this device
const CHEERED = 'cheered-notices'
const cheered = (): string[] => { try { return JSON.parse(localStorage.getItem(CHEERED) ?? '[]') } catch { return [] } }
const markCheered = (id: string) => { try { localStorage.setItem(CHEERED, JSON.stringify([...cheered(), id].slice(-50))) } catch { /* private mode */ } }

/**
 * The bell in the top bar: notices for this person (a tool someone wants to share, for the admin; a tool approved,
 * for its maker), with a dot while any are unread. An approved tool also gets its maker a moment of congratulations.
 */
export function Notices({ onReview }: { onReview: (toolId: string) => void }) {
  const { notices, markNoticesRead, isAdmin } = useStore()
  const [open, setOpen] = useState(false)
  const [cheer, setCheer] = useState<AppNotice | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const unread = notices.filter(n => !n.read_at).length

  // one that arrives now: a word for the admin, a celebration for the maker
  useEffect(() => {
    const on = (e: Event) => {
      const n = (e as CustomEvent<AppNotice>).detail
      if (n.kind === 'tool-published') { if (!cheered().includes(n.id)) setCheer(n) }
      else toast(n.title, isAdmin && n.kind === 'tool-submitted' ? 'Open the bell to review it' : undefined)
    }
    window.addEventListener(NOTICE_EVENT, on)
    return () => window.removeEventListener(NOTICE_EVENT, on)
  }, [isAdmin])
  // one that arrived while the app was closed
  useEffect(() => {
    if (cheer) return
    const n = notices.find(x => x.kind === 'tool-published' && !x.read_at && !cheered().includes(x.id))
    if (n) setCheer(n)
  }, [notices, cheer])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    // seen once the list has been open a moment
    const t = window.setTimeout(() => { if (unread) markNoticesRead() }, 1200)
    return () => { document.removeEventListener('mousedown', away); clearTimeout(t) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (n: AppNotice) => {
    if (unread) markNoticesRead()
    if (n.kind === 'tool-submitted' && n.tool_id && isAdmin) { setOpen(false); onReview(n.tool_id) }
  }
  const closeCheer = () => { if (cheer) markCheered(cheer.id); setCheer(null); markNoticesRead() }

  return (
    <div className="notices" ref={box}>
      <button className={'icon-btn' + (open ? ' on' : '')} title={unread ? `${unread} new` : 'Notifications'} aria-label="Notifications" onClick={() => setOpen(o => !o)}>
        <Bell size={17} />
        {unread > 0 && <span className="notice-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notice-menu" role="dialog" aria-label="Notifications">
          <div className="notice-head">Notifications</div>
          {notices.length ? (
            <ul className="notice-list">
              {notices.map(n => (
                <li key={n.id} className={(n.read_at ? '' : 'unread') + (n.kind === 'tool-submitted' && isAdmin && n.tool_id ? ' actionable' : '')} onClick={() => pick(n)}>
                  <span className="notice-title">{n.title}</span>
                  {n.body && <span className="notice-body">{n.body}</span>}
                  <span className="notice-time">{ago(n.created_at)}{n.kind === 'tool-submitted' && isAdmin && n.tool_id ? ' · Click to review' : ''}</span>
                </li>
              ))}
            </ul>
          ) : <div className="notice-empty">Nothing yet</div>}
        </div>
      )}
      {cheer && createPortal(
        <div className="modal-bg" onMouseDown={closeCheer}>
          <div className="modal cheer" role="dialog" aria-label="Congratulations" onMouseDown={e => e.stopPropagation()}>
            <button className="icon-btn cheer-close" onClick={closeCheer} aria-label="Close"><X size={18} /></button>
            <div className="cheer-icon"><PartyPopper size={34} /></div>
            <h2>Congratulations!</h2>
            <p className="cheer-title">{cheer.title.replace(/^🎉\s*/, '')}</p>
            {cheer.body && <p className="cheer-body">{cheer.body}</p>}
            <button className="btn primary" onClick={closeCheer}>Thanks!</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
