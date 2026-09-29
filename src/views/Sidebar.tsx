import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Plus, Search, SquareSplitHorizontal, X } from 'lucide-react'
import { VaultSwitcher } from './VaultSwitcher'
import { useStore } from '../lib/store'
import { isDailyTitle, prettyDate, todayTitle } from '../lib/links'
import { plainText } from '../lib/html'
import { JOURNAL } from './JournalPane'


interface Props {
  current: string
  /** Titles open in any pane (their "open beside" button is disabled). */
  open: string[]
  searchOpen: boolean
  onSearchOpen: (open: boolean) => void
  onOpen: (title: string) => void
  onOpenBeside: (title: string) => void
  onNew: () => void
}

/** Left column: inline search, all-notes / dates filter, and the list, most recently edited first. */
export function Sidebar({ current, open, searchOpen, onSearchOpen, onOpen, onOpenBeside, onNew }: Props) {
  const { pages } = useStore()
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { if (searchOpen) input.current?.focus(); else setQ('') }, [searchOpen])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    // days live in the journal (one entry at the top); a search finds them too, and opens the journal at that day
    const notes = pages.filter(p => p.kind !== 'canvas' && (s || !isDailyTitle(p.title)))
    const hits = s ? notes.filter(p => p.title.toLowerCase().includes(s) || prettyDate(p.title, true).toLowerCase().includes(s) || plainText(p.body, 0).toLowerCase().includes(s)) : notes
    return [...hits].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [pages, q])

  const today = todayTitle()
  const label = (title: string) => isDailyTitle(title) ? prettyDate(title, true) : title

  const draftIds = new Set(pages.filter(p => p.draft).map(p => p.title))
  const row = (title: string, key: string) => (
    <li key={key} className={title === current ? 'on' : ''} onClick={() => onOpen(title)} title={title}>
      <span className={'row-label' + (isDailyTitle(title) ? ' daily' : '')}>{label(title)}</span>
      {draftIds.has(title) && <span className="row-draft" title="Held back from publishing">draft</span>}
      <button className="row-beside" title="Open to the right" disabled={open.includes(title)}
        onClick={e => { e.stopPropagation(); onOpenBeside(title) }}><SquareSplitHorizontal size={14} /></button>
    </li>
  )

  return (
    <aside className="side">
      <VaultSwitcher />
      <div className="side-head">
        {searchOpen ? (
          <input ref={input} value={q} placeholder="Search notes and days" onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onSearchOpen(false); if (e.key === 'Enter' && list[0]) onOpen(list[0].title) }} />
        ) : null}
        <span className="spacer" />
        <button className="icon-btn" title={searchOpen ? 'Close search' : 'Search'} onClick={() => onSearchOpen(!searchOpen)}>{searchOpen ? <X size={16} /> : <Search size={16} />}</button>
        <button className="icon-btn new-note" title="New note (Ctrl+N)" onClick={onNew}><Plus size={20} strokeWidth={2.5} /></button>
      </div>
      {/* the journal stays put at the top while the notes scroll under it */}
      {!q && (
        <ul className="side-list side-pinned">
          <li key="journal" className={'journal-row' + (current === JOURNAL ? ' on' : '')} onClick={() => onOpen(JOURNAL)} title="All your days, newest first">
            <CalendarDays size={14} className="journal-icon" />
            <span className="row-label">Journal</span>
            <span className="journal-date">{prettyDate(today, true)}</span>
            <button className="row-beside" title="Open to the right" disabled={open.includes(JOURNAL)}
              onClick={e => { e.stopPropagation(); onOpenBeside(JOURNAL) }}><SquareSplitHorizontal size={14} /></button>
          </li>
        </ul>
      )}
      <ul className="side-list">
        {list.map(p => row(p.title, p.id))}
        {list.length === 0 && q && <li className="empty">No matches</li>}
      </ul>
    </aside>
  )
}
