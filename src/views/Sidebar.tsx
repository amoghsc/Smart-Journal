import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, List, Plus, Search, SquareSplitHorizontal, X } from 'lucide-react'
import { VaultSwitcher } from './VaultSwitcher'
import { useStore } from '../lib/store'
import { isDailyTitle, prettyDate, todayTitle } from '../lib/links'
import { plainText } from '../lib/html'

type Filter = 'all' | 'daily'

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
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem('side-filter') as Filter) || 'all')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { if (searchOpen) input.current?.focus(); else setQ('') }, [searchOpen])
  useEffect(() => { localStorage.setItem('side-filter', filter) }, [filter])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    let notes = pages.filter(p => p.kind !== 'canvas')
    if (filter === 'daily') notes = notes.filter(p => isDailyTitle(p.title))
    const hits = s ? notes.filter(p => p.title.toLowerCase().includes(s) || plainText(p.body, 0).toLowerCase().includes(s)) : notes
    return filter === 'daily'
      ? [...hits].sort((a, b) => b.title.localeCompare(a.title))
      : [...hits].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [pages, q, filter])

  const today = todayTitle()
  const hasToday = list.some(p => p.title === today)
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
          <input ref={input} value={q} placeholder={filter === 'daily' ? 'Search days' : 'Search notes'} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onSearchOpen(false); if (e.key === 'Enter' && list[0]) onOpen(list[0].title) }} />
        ) : (
          <div className="seg">
            <button className={filter === 'all' ? 'on' : ''} title="All notes" onClick={() => setFilter('all')}><List size={15} /></button>
            <button className={filter === 'daily' ? 'on' : ''} title="Daily notes" onClick={() => setFilter('daily')}><CalendarDays size={15} /></button>
          </div>
        )}
        <span className="spacer" />
        <button className="icon-btn" title={searchOpen ? 'Close search' : 'Search'} onClick={() => onSearchOpen(!searchOpen)}>{searchOpen ? <X size={16} /> : <Search size={16} />}</button>
        <button className="icon-btn new-note" title="New note (Ctrl+N)" onClick={onNew}><Plus size={20} strokeWidth={2.5} /></button>
      </div>
      <ul className="side-list">
        {!q && !hasToday && row(today, 'today')}
        {list.map(p => row(p.title, p.id))}
        {list.length === 0 && q && <li className="empty">No matches</li>}
      </ul>
    </aside>
  )
}
