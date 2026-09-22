import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { CalendarDays, ChevronLeft, ChevronRight, EyeOff, FolderInput, Globe, MessageSquare, MessageSquareOff, SquareSplitHorizontal, Trash2, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { NoteEditor } from '../components/NoteEditor'
import { Comments } from '../components/Comments'
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
  /** Margin comments are available (single note, no canvas). */
  comments?: boolean
  autoFocus?: boolean
}

/** Bottom-left corner of an element in viewport px (fallback: top-left of the window). */
function rectAnchor(el: Element | null) {
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left, y: r.bottom } : { x: 16, y: 16 }
}

/** One page: title, the editor, margin comments, backlinks. */
export function PagePane({ title, onOpenLink, onNavigate, onRenamed, onNewBeside, onClose, closing, comments, autoFocus }: Props) {
  const { getPage, setBody, ensurePage, renamePage, deletePage, setDraft, movePage, vault, vaults, backlinks, byId } = useStore()
  const page = getPage(title)
  const body = page?.body ?? ''
  const daily = isDailyTitle(title)
  const [titleText, setTitleText] = useState(title)
  const titleInput = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showComments, setShowComments] = useState(() => localStorage.getItem('comments') !== '0')
  const [focusComment, setFocusComment] = useState<string | null>(null)

  useEffect(() => setTitleText(title), [title])
  // the title wraps: size the textarea to its content, and again whenever its width changes
  // (the pane animates open from zero width, so the first measurement is far too tall)
  useLayoutEffect(() => {
    const el = titleInput.current
    if (!el) return
    const fit = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
    fit()
    let w = el.clientWidth
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit() } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [titleText, daily])
  // a freshly created "Untitled" note: put the cursor on the title first
  useEffect(() => { if (!daily && /^untitled( \d+)?$/i.test(title) && !body) titleInput.current?.select() }, [title, daily, body])
  useEffect(() => { localStorage.setItem('comments', showComments ? '1' : '0') }, [showComments])

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
    if (!page || page.local || !body.trim()) { onNavigate(d); return }
    try { await renamePage(page.id, d); onRenamed(title, d) } catch (e) { alert((e as Error).message) }
  }

  const linkedFrom = useMemo(() => (backlinks.get(normTitle(title)) ?? []).map(id => byId.get(id)!).filter(p => p && p.title !== title), [backlinks, byId, title])
  const words = useMemo(() => plainText(body, 0).split(/\s+/).filter(Boolean).length, [body])

  const commitTitle = async () => {
    const next = titleText.replace(/\s+/g, ' ').trim()
    if (!next || next === title) { setTitleText(title); return }
    if (!page) { setTitleText(title); return }
    try { await renamePage(page.id, next); onRenamed(title, next) }
    catch (e) { alert((e as Error).message); setTitleText(title) }
  }

  const move = async () => {
    if (!page) return
    const others = vaults.filter(v => v.id !== page.vault_id)
    if (!others.length) return
    const pick = others.length === 1 ? others[0]
      : others.find(v => v.name === window.prompt(`Move “${page.title}” to which vault?\n\n${others.map(v => v.name).join('\n')}`, others[0].name)?.trim())
    if (!pick) return
    if (!confirm(`Move “${page.title}” to “${pick.name}”?${pick.kind === 'public' ? '\n\nThat vault can be published.' : ''}`)) return
    try { await movePage(page.id, pick.id); onNavigate(todayTitle()) } catch (e) { alert((e as Error).message) }
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
          <textarea ref={titleInput} className="title-input" rows={1} value={titleText} onBlur={commitTitle}
            onChange={e => {
              const v = e.target.value
              if (v.endsWith('/date')) { setTitleText(v.slice(0, -5)); pickDate(rectAnchor(e.currentTarget)).then(d => { if (d) goToDate(d) }); return }
              setTitleText(v)
            }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } if (e.key === 'Escape') { setTitleText(title); e.currentTarget.blur() } }} />
        )}
        <input ref={dateInput} type="date" className="date-hidden" tabIndex={-1} aria-hidden
          onChange={e => { const cb = datePending.current; datePending.current = null; cb?.(e.target.value || null) }} />
        <span className="wc" title="Words in this note">{words} {words === 1 ? 'word' : 'words'}</span>
        <div className="pane-actions">
          {page && vault?.kind === 'public' && (
            <button className={'icon-btn' + (page.draft ? ' on' : '')} title={page.draft ? 'Held back — click to include when publishing' : 'Included when publishing — click to hold back'}
              onClick={() => setDraft(page.id, !page.draft).catch(e => alert((e as Error).message))}>
              {page.draft ? <EyeOff size={16} /> : <Globe size={16} />}
            </button>
          )}
          {page && vaults.length > 1 && <button className="icon-btn" title="Move to another vault" onClick={move}><FolderInput size={16} /></button>}
          {comments && <button className="icon-btn" title={showComments ? 'Hide comments' : 'Show comments'} onClick={() => setShowComments(s => !s)}>{showComments ? <MessageSquare size={16} /> : <MessageSquareOff size={16} />}</button>}
          {onNewBeside && <button className="icon-btn" title="New note to the right" onClick={onNewBeside}><SquareSplitHorizontal size={16} /></button>}
          {page && <button className="icon-btn" title="Delete note" onClick={remove}><Trash2 size={16} /></button>}
          {onClose && <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>}
        </div>
      </div>

      <div ref={scrollRef} className={'pane-scroll' + (showComments ? '' : ' comments-hidden')}>
        <NoteEditor key={title} html={body} onChange={v => setBody(title, v)} onOpenLink={onOpenLink}
          onCreatePage={t => { ensurePage(t).catch(console.error) }} resolveTitle={t => getPage(t)?.title ?? t} pickDate={pickDate}
          comments={comments && showComments} onAddComment={setFocusComment} onReady={setEditor} autoFocus={autoFocus} />
        {comments && showComments && editor && scrollRef.current && (
          <Comments editor={editor} scrollEl={scrollRef.current} focusId={focusComment} onFocused={() => setFocusComment(null)} />
        )}

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
