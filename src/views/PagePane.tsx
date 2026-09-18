import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, SquareSplitHorizontal, Trash2, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { NoteEditor } from '../components/NoteEditor'
import { isDailyTitle, normTitle, prettyDate, shiftDay, todayTitle } from '../lib/links'
import { plainText } from '../lib/html'

interface Props {
  title: string
  /** Open a linked page beside this one. */
  onOpenLink: (title: string) => void
  /** Replace this pane's page (day arrows, backlinks). */
  onNavigate: (title: string) => void
  onRenamed: (from: string, to: string) => void
  onNewBeside?: () => void
  onClose?: () => void
  /** Play the exit animation (the parent removes the pane afterwards). */
  closing?: boolean
  autoFocus?: boolean
}

/** Bottom-left corner of an element in viewport px (fallback: top-left of the window). */
function rectAnchor(el: Element | null) {
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left, y: r.bottom } : { x: 16, y: 16 }
}

/** One page: title, the editor, backlinks. */
export function PagePane({ title, onOpenLink, onNavigate, onRenamed, onNewBeside, onClose, closing, autoFocus }: Props) {
  const { getPage, setBody, ensurePage, renamePage, deletePage, backlinks, byId } = useStore()
  const page = getPage(title)
  const body = page?.body ?? ''
  const daily = isDailyTitle(title)
  const [draft, setDraft] = useState(title)
  const titleInput = useRef<HTMLInputElement>(null)
  // native date picker, opened by "/date" (title or text) and the calendar button
  const dateInput = useRef<HTMLInputElement>(null)
  const datePending = useRef<((d: string | null) => void) | null>(null)
  const pickDate = (anchor?: { x: number; y: number }) => new Promise<string | null>(resolve => {
    const el = dateInput.current
    if (!el) { resolve(null); return }
    datePending.current?.(null)
    datePending.current = resolve
    // the native popup anchors to the input, so park the (invisible) input where the user is
    const a = anchor ?? rectAnchor(titleInput.current)
    el.style.left = `${Math.round(a.x)}px`; el.style.top = `${Math.round(a.y)}px`
    el.value = daily ? title : todayTitle()
    try { el.showPicker() } catch { el.focus(); el.click() }
  })
  /** Make this pane show the given day: an untouched note just navigates, a written one is renamed to that day. */
  const goToDate = async (d: string) => {
    if (!page || page.draft || !body.trim()) { onNavigate(d); return }
    try { await renamePage(page.id, d); onRenamed(title, d) } catch (e) { alert((e as Error).message) }
  }
  useEffect(() => setDraft(title), [title])
  // a freshly created "Untitled" note: put the cursor on the title first
  useEffect(() => { if (!daily && /^untitled( \d+)?$/i.test(title) && !body) titleInput.current?.select() }, [title, daily, body])

  const linkedFrom = useMemo(() => (backlinks.get(normTitle(title)) ?? []).map(id => byId.get(id)!).filter(p => p && p.title !== title), [backlinks, byId, title])

  const commitTitle = async () => {
    const next = draft.trim()
    if (!next || next === title) { setDraft(title); return }
    if (!page) { setDraft(title); return }
    try { await renamePage(page.id, next); onRenamed(title, next) }
    catch (e) { alert((e as Error).message); setDraft(title) }
  }

  const remove = async () => {
    if (!page) return
    if (!confirm(`Delete “${page.title}”?`)) return
    await deletePage(page.id)
    if (onClose) onClose(); else onNavigate(todayTitle())
  }

  return (
    <div className={'pane' + (closing ? ' closing' : '')}>
      <div className="pane-head">
        {daily ? (
          <div className="daily-nav">
            <h1>{prettyDate(title)}</h1>
            <button className="icon-btn" onClick={() => onNavigate(shiftDay(title, -1))} aria-label="Previous day"><ChevronLeft size={18} /></button>
            <button className="icon-btn" onClick={() => onNavigate(shiftDay(title, 1))} aria-label="Next day"><ChevronRight size={18} /></button>
            <button className="icon-btn" title="Pick a date" onClick={e => pickDate(rectAnchor(e.currentTarget)).then(d => d && onNavigate(d))}><CalendarDays size={16} /></button>
            {title !== todayTitle() && <button className="link" onClick={() => onNavigate(todayTitle())}>Today</button>}
          </div>
        ) : (
          <input ref={titleInput} className="title-input" value={draft} onBlur={commitTitle}
            onChange={e => {
              const v = e.target.value
              if (v.endsWith('/date')) { setDraft(v.slice(0, -5)); pickDate(rectAnchor(e.currentTarget)).then(d => { if (d) goToDate(d) }); return }
              setDraft(v)
            }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } if (e.key === 'Escape') { setDraft(title); e.currentTarget.blur() } }} />
        )}
        <input ref={dateInput} type="date" className="date-hidden" tabIndex={-1} aria-hidden
          onChange={e => { const cb = datePending.current; datePending.current = null; cb?.(e.target.value || null) }} />
        <div className="pane-actions">
          {onNewBeside && <button className="icon-btn" title="New note to the right" onClick={onNewBeside}><SquareSplitHorizontal size={16} /></button>}
          {page && <button className="icon-btn" title="Delete note" onClick={remove}><Trash2 size={16} /></button>}
          {onClose && <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>}
        </div>
      </div>

      <div className="pane-scroll">
        <NoteEditor key={title} html={body} onChange={v => setBody(title, v)} onOpenLink={onOpenLink}
          onCreatePage={t => { ensurePage(t).catch(console.error) }} resolveTitle={t => getPage(t)?.title ?? t} pickDate={pickDate} autoFocus={autoFocus} />

        {linkedFrom.length > 0 && (
          <div className="backlinks">
            <h3>Linked from</h3>
            <ul>
              {linkedFrom.map(p => (
                <li key={p.id} onClick={() => onOpenLink(p.title)}>
                  <span className="bl-title">{isDailyTitle(p.title) ? prettyDate(p.title, true) : p.title}</span>
                  <span className="bl-snippet">{plainText(p.body, 120)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
