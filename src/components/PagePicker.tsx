import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import type { Page, PageKind } from '../lib/types'
import { plainText } from '../lib/html'

interface Props {
  title?: string
  kinds?: PageKind[]
  allowCreate?: boolean
  onPick: (title: string) => void
  onClose: () => void
}

/** Search-as-you-type page list; Enter opens the top hit or creates a page named after the query. */
export function PagePicker({ title = 'Pages', kinds = ['note', 'daily'], allowCreate = true, onPick, onClose }: Props) {
  const { pages } = useStore()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const results = useMemo(() => {
    const pool = pages.filter(p => kinds.includes(p.kind))
    const s = q.trim().toLowerCase()
    if (!s) return pool.slice(0, 50)
    const titleHits = pool.filter(p => p.title.toLowerCase().includes(s))
    const bodyHits = pool.filter(p => !titleHits.includes(p) && p.body.toLowerCase().includes(s))
    return [...titleHits, ...bodyHits].slice(0, 50)
  }, [pages, q, kinds])

  const exact = results.some(p => p.title.toLowerCase() === q.trim().toLowerCase())
  const canCreate = allowCreate && q.trim() && !exact
  const rows: (Page | 'create')[] = canCreate ? [...results, 'create'] : results

  useEffect(() => setIdx(0), [q])

  const choose = (r: Page | 'create') => onPick(r === 'create' ? q.trim() : r.title)

  const snippet = (p: Page) => {
    const s = q.trim().toLowerCase()
    if (s && !p.title.toLowerCase().includes(s)) {
      const i = p.body.toLowerCase().indexOf(s)
      return '…' + plainText(p.body.slice(Math.max(0, i - 40), i + 80), 140)
    }
    return plainText(p.body, 100)
  }

  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <input
          ref={input}
          value={q}
          placeholder="Search or type a new title…"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(rows.length - 1, i + 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)) }
            if (e.key === 'Enter' && rows[idx]) { e.preventDefault(); choose(rows[idx]) }
          }}
        />
        <ul className="picker-list">
          {rows.map((r, i) => r === 'create'
            ? <li key="create" className={'create' + (i === idx ? ' active' : '')} onClick={() => choose(r)}>+ New page “{q.trim()}”</li>
            : <li key={r.id} className={i === idx ? 'active' : ''} onClick={() => choose(r)}>
                <span className="picker-title">{r.title}{r.kind !== 'note' && <span className={'badge ' + r.kind}>{r.kind}</span>}</span>
                <span className="picker-snippet">{snippet(r)}</span>
              </li>)}
          {rows.length === 0 && <li className="empty">No pages yet</li>}
        </ul>
      </div>
    </div>
  )
}
