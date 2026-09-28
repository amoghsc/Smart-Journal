import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { isDailyTitle, todayTitle } from '../lib/links'
import { PagePane } from './PagePane'

/** The journal's place in the list of open panes (not a note title: titles can't contain ":"-wrapped names like this). */
export const JOURNAL = ':journal:'

interface Props {
  /** Scroll to this day (YYYY-MM-DD); `n` changes to ask again for the same day. */
  focus: { date: string; n: number }
  onOpenLink: (title: string) => void
  onOpenInVault: (vaultId: string, title: string) => void
  onDuplicate: (title: string) => void
  comments?: boolean
  /** Which days are on screen now (for time spent). */
  onVisible?: (days: string[]) => void
}

/**
 * All daily notes as one continuous page, newest first: future days above, today in focus, the past below.
 * Each day keeps its own header (sticky while its day scrolls by). Days near the screen are editable; the rest show
 * their text until you reach them, so a long journal stays light.
 */
export function JournalPane({ focus, onOpenLink, onOpenInVault, onDuplicate, comments, onVisible }: Props) {
  const { pages } = useStore()
  const scroller = useRef<HTMLDivElement>(null)
  // days asked for that have no note yet (picked on the calendar): shown, empty, until you write
  const [extra, setExtra] = useState<string[]>([])
  const [live, setLive] = useState<Set<string>>(() => new Set([focus.date]))
  const today = todayTitle()

  const days = useMemo(() => {
    const set = new Set(pages.filter(p => isDailyTitle(p.title) && p.kind !== 'canvas').map(p => p.title))
    set.add(today)
    for (const d of extra) set.add(d)
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [pages, today, extra])

  /** Bring a day to the top (adding it if it has no note yet). */
  const pending = useRef<string | null>(focus.date)
  const scrollTo = (date: string) => {
    if (!days.includes(date)) setExtra(e => (e.includes(date) ? e : [...e, date]))
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
  }, [days])

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
  }, [days])

  return (
    <div className="pane journal">
      <div ref={scroller} className="journal-scroll">
        {days.map(d => (
          <PagePane key={d} title={d} section={{ live: live.has(d) }} comments={comments}
            onOpenLink={onOpenLink} onOpenInVault={onOpenInVault} onDuplicate={onDuplicate}
            onNavigate={scrollTo} onRenamed={() => {}} />
        ))}
      </div>
    </div>
  )
}
