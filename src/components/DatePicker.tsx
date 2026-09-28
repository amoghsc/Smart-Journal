import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { answerDate, onDateRequest, type DateRequest } from '../lib/datePicker'
import { useStore } from '../lib/store'
import { isDailyTitle, todayTitle } from '../lib/links'
import { plainText } from '../lib/html'

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
/** The week starts on the day the reader's locale starts it (Sunday where unknown). */
const firstDay = (() => { try { const w = (new Intl.Locale(navigator.language) as unknown as { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } }); return ((w.getWeekInfo?.() ?? w.weekInfo)?.firstDay ?? 7) % 7 } catch { return 0 } })()

/** The app's calendar: a month at a time, a dot under days that have a note, arrow keys to move, Enter to pick. */
export function DatePickerHost() {
  const [req, setReq] = useState<DateRequest | null>(null)
  useEffect(() => onDateRequest(setReq), [])
  return req ? <Calendar key={`${req.anchor.x},${req.anchor.y},${req.value}`} req={req} /> : null
}

function Calendar({ req }: { req: DateRequest }) {
  const { pages } = useStore()
  const [cursor, setCursor] = useState(() => parse(isDailyTitle(req.value) ? req.value : todayTitle()))
  const month = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const box = useRef<HTMLDivElement>(null)
  const today = todayTitle()

  // days that have something written
  const written = useMemo(() => new Set(pages.filter(p => isDailyTitle(p.title) && plainText(p.body, 0).trim()).map(p => p.title)), [pages])

  const days = useMemo(() => {
    const start = new Date(month)
    start.setDate(1 - ((month.getDay() - firstDay + 7) % 7))
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
  }, [month.getTime()]) // eslint-disable-line react-hooks/exhaustive-deps
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + firstDay + i).toLocaleDateString(undefined, { weekday: 'narrow' }))

  const move = (days: number) => setCursor(c => { const d = new Date(c); d.setDate(d.getDate() + days); return d })
  const moveMonth = (n: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, Math.min(c.getDate(), 28)))

  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) answerDate(null) }
    const keys = (e: KeyboardEvent) => {
      const k: Record<string, () => void> = {
        Escape: () => answerDate(null), Enter: () => answerDate(ymd(cursor)),
        ArrowLeft: () => move(-1), ArrowRight: () => move(1), ArrowUp: () => move(-7), ArrowDown: () => move(7),
        PageUp: () => moveMonth(-1), PageDown: () => moveMonth(1),
      }
      if (k[e.key]) { e.preventDefault(); e.stopPropagation(); k[e.key]() }
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', keys, true) }
  }, [cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  // below the anchor, or above it / pulled left when there's no room
  const W = 300, H = 340
  const left = Math.max(8, Math.min(req.anchor.x, window.innerWidth - W - 8))
  const top = req.anchor.y + H + 8 < window.innerHeight ? req.anchor.y + 6 : Math.max(8, req.anchor.y - H - 30)

  return (
    <div ref={box} className="cal" role="dialog" aria-label="Pick a date" style={{ left, top, width: W }}>
      <div className="cal-head">
        <button className="icon-btn" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={18} /></button>
        <span className="cal-title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="icon-btn" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={18} /></button>
      </div>
      <div className="cal-grid" role="grid">
        {weekdays.map((w, i) => <span key={'w' + i} className="cal-wd">{w}</span>)}
        {days.map(d => {
          const key = ymd(d)
          const cls = ['cal-day', d.getMonth() !== month.getMonth() && 'out', key === today && 'today', key === req.value && 'chosen', key === ymd(cursor) && 'cursor'].filter(Boolean).join(' ')
          return (
            <button key={key} className={cls} role="gridcell" aria-label={d.toDateString() + (written.has(key) ? ', has a note' : '')} onClick={() => answerDate(key)}>
              {d.getDate()}
              {written.has(key) && <span className="cal-dot" />}
            </button>
          )
        })}
      </div>
      <div className="cal-foot"><button className="link" onClick={() => answerDate(today)}>Today</button></div>
    </div>
  )
}
