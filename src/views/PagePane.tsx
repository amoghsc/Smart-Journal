import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, EyeOff, Globe, MessageSquare, MessageSquareOff, Search, Share, SquareSplitHorizontal, Trash2, X } from 'lucide-react'
import { planSite } from '../lib/publish'
import { copyText, toast } from '../lib/toast'
import { formatDuration, useUnsavedSeconds } from '../lib/activeTime'
import { useStore } from '../lib/store'
import { NoteEditor } from '../components/NoteEditor'
import { Comments } from '../components/Comments'
import { CopyToVault } from '../components/CopyToVault'
import { isDailyTitle, normTitle, prettyDate, shiftDay, todayTitle } from '../lib/links'
import { plainText, wordStats } from '../lib/html'
import { noteSearchKey, setNoteSearch, setNoteSearchCurrent } from '../lib/noteSearch'

interface Props {
  title: string
  /** Open a linked page beside this one. */
  onOpenLink: (title: string) => void
  /** Replace this pane's page (day arrows, backlinks). */
  onNavigate: (title: string) => void
  onRenamed: (from: string, to: string) => void
  /** Switch to another vault and show a note there (after copying). */
  onOpenInVault: (vaultId: string, title: string) => void
  onNewBeside?: () => void
  /** Show a just-made duplicate of this note beside it. */
  onDuplicate?: (title: string) => void
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
export function PagePane({ title, onOpenLink, onNavigate, onRenamed, onOpenInVault, onNewBeside, onDuplicate, onClose, closing, comments, autoFocus }: Props) {
  const { pages, pagesIn, getPage, setBody, ensurePage, renamePage, deletePage, setDraft, vault, vaults, backlinks, byId, addWords, duplicatePage, saveNow } = useStore()
  const page = getPage(title)
  const body = page?.body ?? ''
  const daily = isDailyTitle(title)
  const [titleText, setTitleText] = useState(title)
  const titleInput = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showComments, setShowComments] = useState(() => localStorage.getItem('comments') !== '0')
  const [focusComment, setFocusComment] = useState<string | null>(null)
  // backlinks height: null = grows with its content (capped); a number once the user drags the divider
  const [blHeight, setBlHeight] = useState<number | null>(() => { const v = Number(localStorage.getItem('backlinks-h')); return v > 0 ? v : null })
  const paneRef = useRef<HTMLDivElement>(null)
  const blRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: blRef.current?.offsetHeight ?? 0 }
  }
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const max = (paneRef.current?.clientHeight ?? 600) * 0.8
    setBlHeight(Math.round(Math.min(max, Math.max(56, drag.current.h - (e.clientY - drag.current.y)))))
  }
  const onDividerUp = () => {
    if (!drag.current) return
    drag.current = null
    setBlHeight(h => { if (h) localStorage.setItem('backlinks-h', String(h)); return h })
  }
  const resetBacklinks = () => { setBlHeight(null); localStorage.removeItem('backlinks-h') }

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
  // struck-through words don't count; they're shown separately as removed
  const { words, struck } = useMemo(() => wordStats(body), [body])
  // notes offered by the [[ picker: this vault, most recently edited first
  const linkable = useMemo(() => pages
    .filter(p => !p.local && p.kind !== 'canvas' && p.title !== title)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(p => p.title), [pages, title])

  /** Duplicate the note (to keep the original as it is before big changes) and show the copy beside it. */
  const [duplicating, setDuplicating] = useState(false)
  const duplicate = async () => {
    if (!page || page.local || duplicating) return
    setDuplicating(true)
    try {
      await saveNow()
      const copy = await duplicatePage(page.id)
      onDuplicate?.(copy.title)
      toast(`Duplicated as “${copy.title}”`, copy.draft && vault?.kind === 'public' ? 'Held back from publishing' : undefined)
    } catch (e) { toast('Couldn’t duplicate this note', (e as Error).message) } finally { setDuplicating(false) }
  }

  // ---- find in this note: highlights in the text, and marks beside the scrollbar for where each match is ----
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ count: number; current: number }>({ count: 0, current: -1 })
  const [marks, setMarks] = useState<{ hit: number; top: number; current: boolean }[]>([])
  const findInput = useRef<HTMLInputElement>(null)
  const openFind = () => {
    // start from the selected words, if any
    const sel = editor?.state.selection
    const picked = sel && !sel.empty ? editor!.state.doc.textBetween(sel.from, sel.to, ' ').trim() : ''
    if (picked && picked.length <= 60 && !picked.includes('\n')) setQuery(picked)
    setFindOpen(true)
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select() })
  }
  const closeFind = () => { setFindOpen(false); setQuery(''); editor?.commands.focus() }
  // search as you type; follow the editor so counts stay right while the note changes
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    setNoteSearch(editor.view, findOpen ? query : '')
    const sync = () => { const st = noteSearchKey.getState(editor.state); setHits({ count: st?.hits.length ?? 0, current: st?.current ?? -1 }) }
    sync()
    editor.on('transaction', sync)
    return () => { editor.off('transaction', sync) }
  }, [editor, query, findOpen])
  const showHit = (i: number) => {
    if (!editor || !hits.count) return
    setNoteSearchCurrent(editor.view, (i + hits.count) % hits.count)
    requestAnimationFrame(() => scrollRef.current?.querySelector('.search-hit.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  // where each match sits in the whole note, as a share of its height: that's where its mark goes beside the scrollbar
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !findOpen || !hits.count) { setMarks([]); return }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect(), total = el.scrollHeight || 1
        // a match across formatting is drawn in pieces: one mark per match, at its first piece
        const first = new Map<number, HTMLElement>()
        el.querySelectorAll<HTMLElement>('.search-hit').forEach(h => { const i = Number(h.dataset.hit); if (!first.has(i)) first.set(i, h) })
        setMarks([...first].sort(([a], [b]) => a - b).map(([hit, h]) => ({
          hit,
          top: (h.getBoundingClientRect().top - box.top + el.scrollTop) / total * 100,
          current: h.classList.contains('current'),
        })))
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => { cancelAnimationFrame(frame); ro.disconnect() }
  }, [findOpen, hits, body])
  // the marks sit a little inside the scrollbar (a thin overlay scrollbar takes no width, so allow for one)
  const scrollbarWidth = scrollRef.current ? scrollRef.current.offsetWidth - scrollRef.current.clientWidth : 0
  const marksRight = Math.max(scrollbarWidth, 10) + 12

  /** Copy a link to this note: its public address if the vault is on the site, otherwise a link into the app. */
  const share = async () => {
    if (!page || !vault) return
    let url = '', detail: string | undefined
    if (vault.kind === 'public' && vault.published_slug && vault.site_url) {
      const s = planSite(pagesIn(vault.id)).included.find(x => x.page.id === page.id)
      if (s) {
        url = `${vault.site_url.replace(/\/?$/, '/')}${vault.published_slug}/${s.path}/`
        const since = vault.published_at && page.created_at > vault.published_at
        detail = since ? 'Publish the vault for this link to work' : url.replace(/^https?:\/\//, '')
      }
    }
    if (!url) {
      url = `${location.origin}${location.pathname}?vault=${vault.id}&open=${encodeURIComponent(page.title)}`
      detail = vault.kind === 'public' ? 'Opens in your journal — this note isn’t on your site yet' : 'Opens in your journal (private vault)'
    }
    try { await copyText(url); toast('Link to this note copied', detail) }
    catch { toast('Couldn’t copy the link') }
  }

  const commitTitle = async () => {
    const next = titleText.replace(/\s+/g, ' ').trim()
    if (!next || next === title) { setTitleText(title); return }
    if (!page) { setTitleText(title); return }
    try { await renamePage(page.id, next); onRenamed(title, next) }
    catch (e) { alert((e as Error).message); setTitleText(title) }
  }

  const remove = async () => {
    if (!page) return
    if (!confirm(`Delete “${page.title}”?`)) return
    await deletePage(page.id)
    if (onClose) onClose(); else onNavigate(todayTitle())
  }

  return (
    <div ref={paneRef} className={'pane' + (closing ? ' closing' : '') + (comments && showComments && body.includes('data-comment-id') ? ' with-comments' : '')}>
      <div className="pane-head">
        <div className="pane-title">
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
          <div className="pane-meta">
            <span title="Words in this note (struck-through words not counted)">{words === 1 ? 'word' : 'words'} {words}</span>
            {struck > 0 && <span title="Struck-through words"> · <s>removed</s> {struck}</span>}
            <NoteTime saved={page?.active_seconds ?? 0} id={page?.local ? undefined : page?.id} />
          </div>
        </div>
        <input ref={dateInput} type="date" className="date-hidden" tabIndex={-1} aria-hidden
          onChange={e => { const cb = datePending.current; datePending.current = null; cb?.(e.target.value || null) }} />
        <div className="pane-actions">
          {page && vault?.kind === 'public' && (
            <button className={'icon-btn' + (page.draft ? ' on' : '')} title={page.draft ? 'Held back — click to include when publishing' : 'Included when publishing — click to hold back'}
              onClick={() => setDraft(page.id, !page.draft).catch(e => alert((e as Error).message))}>
              {page.draft ? <EyeOff size={16} /> : <Globe size={16} />}
            </button>
          )}
          {page && <button className={'icon-btn' + (findOpen ? ' on' : '')} title="Find in this note" onClick={() => (findOpen ? closeFind() : openFind())}><Search size={16} /></button>}
          {page && !page.local && <button className="icon-btn" title="Duplicate this note (the original stays as it is)" onClick={duplicate} disabled={duplicating}><Copy size={16} /></button>}
          {page && !page.local && vaults.length > 1 && <CopyToVault page={page} onOpenCopy={onOpenInVault} />}
          {comments && <button className="icon-btn" title={showComments ? 'Hide comments' : 'Show comments'} onClick={() => setShowComments(s => !s)}>{showComments ? <MessageSquare size={16} /> : <MessageSquareOff size={16} />}</button>}
          {page && !page.local && <button className="icon-btn" title="Copy link to this note" onClick={share}><Share size={16} /></button>}
          {onNewBeside && <button className="icon-btn" title="New note to the right" onClick={onNewBeside}><SquareSplitHorizontal size={16} /></button>}
          {page && <button className="icon-btn" title="Delete note" onClick={remove}><Trash2 size={16} /></button>}
          {onClose && <button className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>}
        </div>
      </div>

      {findOpen && (
        <div className="note-find" role="search">
          <Search size={14} className="note-find-icon" />
          <input ref={findInput} value={query} placeholder="Find in this note" aria-label="Find in this note"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); showHit(hits.current + (e.shiftKey ? -1 : 1)) }
              if (e.key === 'Escape') { e.preventDefault(); closeFind() }
            }} />
          <span className="note-find-count">{query.trim() ? (hits.count ? `${hits.current + 1} of ${hits.count}` : 'No matches') : ''}</span>
          <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!hits.count} onClick={() => showHit(hits.current - 1)}><ChevronUp size={15} /></button>
          <button className="icon-btn" title="Next (Enter)" disabled={!hits.count} onClick={() => showHit(hits.current + 1)}><ChevronDown size={15} /></button>
          <button className="icon-btn" title="Close (Esc)" onClick={closeFind}><X size={15} /></button>
        </div>
      )}

      <div className="pane-body">
      <div ref={scrollRef} className={'pane-scroll' + (showComments ? '' : ' comments-hidden')}>
        <NoteEditor key={title} html={body} onChange={v => setBody(title, v)} onOpenLink={onOpenLink}
          onCreatePage={t => { ensurePage(t).catch(console.error) }} resolveTitle={t => getPage(t)?.title ?? t} titles={linkable} pickDate={pickDate}
          comments={comments && showComments} onAddComment={setFocusComment} onReady={setEditor} autoFocus={autoFocus}
          pageId={page && !page.local ? page.id : undefined} typedWords={page?.typed_words ?? 0}
          onTyped={n => { if (!page || page.local) return false; addWords(page.id, n).catch(console.error); return true }} />
        {comments && showComments && editor && scrollRef.current && (
          <Comments editor={editor} scrollEl={scrollRef.current} focusId={focusComment} onFocused={() => setFocusComment(null)} />
        )}
      </div>
      {marks.length > 0 && (
        <div className="find-marks" style={{ right: marksRight }} aria-hidden>
          {marks.map(m => <button key={m.hit} tabIndex={-1} className={'find-mark' + (m.current ? ' current' : '')} style={{ top: `${m.top}%` }} onClick={() => showHit(m.hit)} />)}
        </div>
      )}
      </div>

      {linkedFrom.length > 0 && <>
        <div className="bl-divider" role="separator" aria-orientation="horizontal" title="Drag to resize · double-click to reset"
          onPointerDown={onDividerDown} onPointerMove={onDividerMove} onPointerUp={onDividerUp} onPointerCancel={onDividerUp} onDoubleClick={resetBacklinks} />
        <div ref={blRef} className={'backlinks' + (blHeight == null ? ' auto' : '')} style={blHeight == null ? undefined : { height: blHeight }}>
          <h3>Linked from <span className="bl-count">{linkedFrom.length}</span></h3>
          <ul>
            {linkedFrom.map(p => (
              <li key={p.id} onClick={() => onOpenLink(p.title)}>
                <span className="bl-title">{isDailyTitle(p.title) ? prettyDate(p.title, true) : p.title}</span>
                <span className="bl-snippet">{plainText(p.body, 120)}</span>
              </li>
            ))}
          </ul>
        </div>
      </>}
    </div>
  )
}

/** Time spent on the note: the saved total plus what this device hasn't saved yet. Re-renders on its own. */
function NoteTime({ saved, id }: { saved: number; id: string | undefined }) {
  const unsaved = useUnsavedSeconds(id)
  const text = formatDuration(saved + unsaved)
  return text ? <span title="Time spent on this note while you were active"> · Working on for: {text}</span> : null
}
