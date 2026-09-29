import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { isDailyTitle, todayTitle } from '../lib/links'
import { countMatches, shownMatches } from '../lib/findText'
import { PagePane } from './PagePane'

/** The journal's place in the list of open panes (not a note title: titles can't contain ":"-wrapped names like this). */
export const JOURNAL = ':journal:'

/** Notes drawn at a time: the day in focus and the 10 before it, then 10 more whenever you reach the 8th of the last 10. */
const BATCH = 10
const AHEAD = 3

interface Props {
  /** Scroll to this day (YYYY-MM-DD); `n` changes to ask again for the same day. */
  focus: { date: string; n: number }
  onOpenLink: (title: string) => void
  onOpenInVault: (vaultId: string, title: string) => void
  onDuplicate: (title: string) => void
  comments?: boolean
  /** Which days are on screen now (for time spent). */
  onVisible?: (days: string[]) => void
  /** Opened beside another note: it can be closed. */
  onClose?: () => void
  closing?: boolean
}

/**
 * All daily notes as one continuous page, newest first: future days above, today in focus, the past below.
 * Each day keeps its own header (sticky while its day scrolls by). Notes are drawn a batch at a time as you scroll
 * down; days near the screen are editable, the rest show their text until you reach them, so a long journal stays
 * light. Find searches every day, drawn or not, and marks each match beside the scrollbar.
 */
export function JournalPane({ focus, onOpenLink, onOpenInVault, onDuplicate, comments, onVisible, onClose, closing }: Props) {
  const { pages } = useStore()
  const scroller = useRef<HTMLDivElement>(null)
  // days asked for that have no note yet (picked on the calendar): shown, empty, until you write
  const [extra, setExtra] = useState<string[]>([])
  const [live, setLive] = useState<Set<string>>(() => new Set([focus.date]))
  const today = todayTitle()

  const daily = useMemo(() => pages.filter(p => isDailyTitle(p.title) && p.kind !== 'canvas'), [pages])
  const days = useMemo(() => {
    const set = new Set(daily.map(p => p.title))
    set.add(today)
    for (const d of extra) set.add(d)
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [daily, today, extra])
  const bodies = useMemo(() => new Map(daily.map(p => [p.title, p.body])), [daily])

  // ---- drawn so far: every day down to `oldest` (worked out from the focus until you scroll further) ----
  const [oldest, setOldest] = useState<string | null>(null)
  const floor = oldest ?? days[Math.min(days.length - 1, Math.max(0, days.indexOf(focus.date)) + BATCH)]
  /** Draw `n` more notes below the ones drawn. */
  const drawMore = (n = BATCH) => setOldest(o => {
    const cur = o ?? floor, i = days.indexOf(cur)
    return days[Math.min(days.length - 1, (i < 0 ? 0 : i) + n)]
  })

  // ---- find in the whole journal ----
  const [find, setFind] = useState<{ query: string; current: number; moved: boolean } | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  // searched a moment after typing stops: every day is read on each search
  const [q, setQ] = useState('')
  useEffect(() => {
    const next = find?.query.trim() ?? ''
    if (!next) { setQ(''); return }
    const t = window.setTimeout(() => setQ(next), 150)
    return () => clearTimeout(t)
  }, [find?.query])
  // matches per day, newest day first (the order they're on the page)
  const hitDays = useMemo(() => (q ? days.map(day => ({ day, count: countMatches(bodies.get(day) ?? '', q) })).filter(d => d.count) : []), [q, days, bodies])
  const total = hitDays.reduce((n, d) => n + d.count, 0)
  const current = find && total ? Math.min(find.current, total - 1) : -1
  /** The day a match (numbered across the journal) is in, and its number within that day. */
  const locate = (i: number) => {
    let base = 0
    for (const d of hitDays) { if (i < base + d.count) return { day: d.day, local: i - base }; base += d.count }
    return null
  }
  const at = current >= 0 ? locate(current) : null
  const openFind = (picked: string) => {
    setFind(f => ({ query: picked || f?.query || '', current: 0, moved: false }))
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select() })
  }
  const closeFind = () => setFind(null)
  // Enter goes to the current match first, then on from there
  const [jump, setJump] = useState(0)
  const go = (i: number) => {
    if (!total) return
    setFind(f => f && { ...f, current: ((i % total) + total) % total, moved: true })
    setJump(j => j + 1)
  }
  const step = (by: 1 | -1) => go(find?.moved ? current + by : current)

  // every day down to the oldest match is drawn while searching, so each match has a place on the page
  const lowest = hitDays.length && hitDays[hitDays.length - 1].day < floor ? hitDays[hitDays.length - 1].day : floor
  const shown = useMemo(() => days.filter(d => !lowest || d >= lowest), [days, lowest])
  const allDrawn = shown.length === days.length

  /** Bring a day to the top (adding it if it has no note yet, and drawing the notes down to it). */
  const pending = useRef<string | null>(focus.date)
  const scrollTo = (date: string) => {
    if (!days.includes(date)) setExtra(e => (e.includes(date) ? e : [...e, date]))
    setOldest(o => {
      const cur = o ?? floor
      if (cur && date >= cur) return o
      const older = days.filter(d => d < date)
      return older.length ? older[Math.min(older.length, BATCH) - 1] : date
    })
    setLive(l => new Set(l).add(date))
    pending.current = date
  }
  useEffect(() => { scrollTo(focus.date) }, [focus.n]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const date = pending.current, box = scroller.current
    if (!date || !box) return
    const el = box.querySelector<HTMLElement>(`[data-date="${date}"]`)
    if (!el) return
    pending.current = null
    // the days above may still be settling (editors mounting, fonts): keep the day at the top for a moment,
    // unless you start scrolling yourself
    let yours = false
    const mine = () => { yours = true }
    box.addEventListener('wheel', mine, { passive: true, once: true })
    box.addEventListener('touchstart', mine, { passive: true, once: true })
    box.addEventListener('keydown', mine, { once: true })
    const pin = () => { if (!yours) box.scrollTop = el.offsetTop }
    pin()
    // (not cleared on re-render: the journal re-renders right after opening, and these must still run)
    for (const ms of [60, 200, 450, 900]) window.setTimeout(pin, ms)
    window.setTimeout(() => { box.removeEventListener('wheel', mine); box.removeEventListener('touchstart', mine); box.removeEventListener('keydown', mine) }, 1000)
  })

  // reaching the 8th of the last 10 notes drawn draws 10 more (a little before it's on screen, so it's ready)
  useEffect(() => {
    const box = scroller.current
    if (!box || allDrawn) return
    const el = box.querySelector(`[data-date="${shown[Math.max(0, shown.length - AHEAD)]}"]`)
    if (!el) return
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) drawMore() }, { root: box, rootMargin: '0px 0px 400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, allDrawn]) // eslint-disable-line react-hooks/exhaustive-deps

  // which days are near the screen: those get a live editor
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const io = new IntersectionObserver(entries => {
      setLive(prev => {
        const next = new Set(prev)
        for (const e of entries) {
          const d = (e.target as HTMLElement).dataset.date!
          if (e.isIntersecting) next.add(d); else next.delete(d)
        }
        return next.size === prev.size && [...next].every(d => prev.has(d)) ? prev : next
      })
    }, { root: box, rootMargin: '900px 0px' })
    box.querySelectorAll('[data-date]').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [shown])

  // the days actually on screen, as you scroll
  const visibleRef = useRef(onVisible); visibleRef.current = onVisible
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = box.getBoundingClientRect()
        visibleRef.current?.([...box.querySelectorAll<HTMLElement>('[data-date]')]
          .filter(el => { const b = el.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom })
          .map(el => el.dataset.date!))
      })
    }
    report()
    box.addEventListener('scroll', report, { passive: true })
    return () => { box.removeEventListener('scroll', report); cancelAnimationFrame(frame); visibleRef.current?.([]) }
  }, [shown])

  /** Where match `local` of `day` is on screen: its highlight in an editable day, or its range in a day shown as text. */
  const hitRects = (day: string): DOMRect[] => {
    const sec = scroller.current?.querySelector(`[data-date="${day}"]`)
    if (!sec) return []
    const ranges = shownMatches(day)
    if (ranges) return ranges.map(r => r.getBoundingClientRect())
    // a match across formatting is drawn in pieces: its first piece
    const first = new Map<number, DOMRect>()
    sec.querySelectorAll<HTMLElement>('.search-hit').forEach(h => { const i = Number(h.dataset.hit); if (!first.has(i)) first.set(i, h.getBoundingClientRect()) })
    return [...first].sort(([a], [b]) => a - b).map(([, r]) => r)
  }

  // go to the current match: centred in the journal (it may be in a day that's still text; it turns editable on arrival)
  useEffect(() => {
    if (!jump || !at) return
    const frame = requestAnimationFrame(() => {
      const box = scroller.current, r = hitRects(at.day)[at.local]
      if (!box || !r) return
      const top = box.getBoundingClientRect().top
      box.scrollTo({ top: box.scrollTop + r.top - top - box.clientHeight / 2, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [jump]) // eslint-disable-line react-hooks/exhaustive-deps

  // a mark beside the scrollbar for every match, at its place in the whole journal
  const [marks, setMarks] = useState<{ hit: number; top: number; current: boolean }[]>([])
  useEffect(() => {
    const box = scroller.current
    if (!box || !find || !total) { setMarks(m => (m.length ? [] : m)); return }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const origin = box.getBoundingClientRect().top - box.scrollTop, height = box.scrollHeight || 1
        const next: typeof marks = []
        let base = 0
        for (const { day, count } of hitDays) {
          hitRects(day).slice(0, count).forEach((r, i) => next.push({ hit: base + i, top: (r.top - origin) / height * 100, current: base + i === current }))
          base += count
        }
        const same = (a: typeof marks, b: typeof marks) => a.length === b.length && a.every((m, i) => m.hit === b[i].hit && m.current === b[i].current && Math.abs(m.top - b[i].top) < 0.05)
        setMarks(prev => (same(prev, next) ? prev : next))
      })
    }
    measure()
    // days grow as editors mount and settle; the highlights of a day that turned editable appear a moment later
    const timers = [150, 500, 1200].map(ms => window.setTimeout(measure, ms))
    const ro = new ResizeObserver(measure)
    box.querySelectorAll('[data-date]').forEach(el => ro.observe(el))
    return () => { cancelAnimationFrame(frame); timers.forEach(clearTimeout); ro.disconnect() }
  }, [find, total, hitDays, current, shown, live]) // eslint-disable-line react-hooks/exhaustive-deps
  const box = scroller.current
  const marksRight = Math.max(box ? box.offsetWidth - box.clientWidth : 0, 10) + 12

  return (
    <div className={'pane journal' + (closing ? ' closing' : '')}>
      {onClose && <button className="icon-btn journal-close" title="Close the journal" onClick={onClose}><X size={18} /></button>}
      {find && (
        <div className="note-find" role="search">
          <Search size={14} className="note-find-icon" />
          <input ref={findInput} value={find.query} placeholder="Find in all journal notes" aria-label="Find in all journal notes"
            onChange={e => setFind({ query: e.target.value, current: 0, moved: false })}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
              if (e.key === 'Escape') { e.preventDefault(); closeFind() }
            }} />
          <span className="note-find-count" title={hitDays.length ? `In ${hitDays.length} ${hitDays.length === 1 ? 'day' : 'days'}` : undefined}>
            {q ? (total ? `${current + 1} of ${total}` : 'No matches') : ''}
          </span>
          <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!total} onClick={() => step(-1)}><ChevronUp size={15} /></button>
          <button className="icon-btn" title="Next (Enter)" disabled={!total} onClick={() => step(1)}><ChevronDown size={15} /></button>
          <button className="icon-btn" title="Close (Esc)" onClick={closeFind}><X size={15} /></button>
        </div>
      )}
      <div className="journal-body">
        <div ref={scroller} className="journal-scroll">
          {shown.map(d => (
            <PagePane key={d} title={d} comments={comments}
              section={{ live: live.has(d), onFind: openFind, find: find && q ? { query: q, current: at?.day === d ? at.local : -1 } : undefined }}
              onOpenLink={onOpenLink} onOpenInVault={onOpenInVault} onDuplicate={onDuplicate}
              onNavigate={scrollTo} onRenamed={() => {}} />
          ))}
        </div>
        {marks.length > 0 && (
          <div className="find-marks" style={{ right: marksRight }} aria-hidden>
            {marks.map(m => <button key={m.hit} tabIndex={-1} className={'find-mark' + (m.current ? ' current' : '')} style={{ top: `${m.top}%` }} onClick={() => go(m.hit)} />)}
          </div>
        )}
      </div>
    </div>
  )
}
