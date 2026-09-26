import { useCallback, useEffect, useRef, useState } from 'react'
import { Globe, LayoutGrid, PanelLeft, Settings } from 'lucide-react'
import { useStore } from './lib/store'
import { supabase } from './lib/supabase'
import { todayTitle } from './lib/links'
import { startActiveTime } from './lib/activeTime'
import { WRITE_FIRST_WORDS, aiScoreGemini, aiScoreOn, aiTwoVersions, aiWriteFirst, setAiScoreGemini, setAiScoreOn, setAiTwoVersions, setAiWriteFirst } from './lib/settings'
import { Login } from './views/Login'
import { SetPassword } from './views/SetPassword'
import { PagePane } from './views/PagePane'
import { Sidebar } from './views/Sidebar'
import { CanvasPane } from './views/CanvasPane'
import { PublishDialog } from './views/PublishDialog'
import { SplitPane } from './components/SplitPane'

type Theme = 'system' | 'light' | 'dark'
const applyTheme = (t: Theme) => { if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t }
const applyAnim = (on: boolean) => { if (on) delete document.documentElement.dataset.anim; else document.documentElement.dataset.anim = 'off' }
const PANE_OUT_MS = 180

/** Note text sizes: the first is the original 15px; the middle is the default. */
const TEXT_SIZES = [{ id: 's', px: 15, label: 'Small' }, { id: 'm', px: 17, label: 'Medium' }, { id: 'l', px: 19, label: 'Large' }] as const
type TextSize = typeof TEXT_SIZES[number]['id']
const applyTextSize = (id: TextSize) => document.documentElement.style.setProperty('--note-size', `${TEXT_SIZES.find(t => t.id === id)!.px}px`)

const MAX_PANES = 3

/** Panes after duplicating pane `i` as `title` (see openDuplicate). */
export function placeDuplicate(panes: string[], i: number, title: string, max = MAX_PANES): string[] {
  const next = [...panes.slice(0, i + 1), title, ...panes.slice(i + 1)]
  if (next.length <= max) return next
  return i < max - 1 ? next.slice(0, max) : next.slice(next.length - max)
}

const titleFromHash = () => {
  const m = /^#\/page\/(.+)$/.exec(location.hash)
  return m ? decodeURIComponent(m[1]) : null
}

export default function App() {
  const { session, ready, recovering } = useStore()
  if (!ready) return <div className="center-screen muted">Loading…</div>
  if (recovering) return <SetPassword />
  if (!session) return <Login />
  return <Workspace email={session.user.email ?? ''} />
}

function Workspace({ email }: { email: string }) {
  const { pages, vault, setVault, getPage, createLocal, discardLocal, addTime, canPublish } = useStore()
  // open pages, left to right; the first is the "main" one the sidebar controls
  // a fresh start opens today; a reload in the same tab (e.g. after a crash) returns to the notes that were open
  const [panes, setPanes] = useState<string[]>(() => {
    try { const s = JSON.parse(sessionStorage.getItem('sj-panes') ?? 'null'); if (Array.isArray(s) && s.length && s.every(t => typeof t === 'string')) return s } catch { /* none saved */ }
    return [todayTitle()]
  })
  useEffect(() => { try { sessionStorage.setItem('sj-panes', JSON.stringify(panes)) } catch { /* private mode */ } }, [panes])
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('sidebar') !== '0')
  const [searchOpen, setSearchOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'system')
  const [anim, setAnim] = useState(() => localStorage.getItem('anim') !== '0')
  const [textSize, setTextSize] = useState<TextSize>(() => { const v = localStorage.getItem('text-size'); return v === 's' || v === 'l' ? v : 'm' })
  const [aiTwo, setAiTwo] = useState(aiTwoVersions)
  const [aiScore, setAiScore] = useState(aiScoreOn)
  const [aiGemini, setAiGemini] = useState(aiScoreGemini)
  const [writeFirst, setWriteFirst] = useState(aiWriteFirst)
  const [focusLast, setFocusLast] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [closing, setClosing] = useState<string[]>([])
  // canvas sits between the sidebar and the note; while it is open only the left-most note shows
  const [canvasOpen, setCanvasOpen] = useState(() => localStorage.getItem('canvas-open') === '1')
  const [canvasMounted, setCanvasMounted] = useState(canvasOpen)
  const [canvasId, setCanvasId] = useState<string | null>(() => localStorage.getItem('canvas'))

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => { applyAnim(anim); localStorage.setItem('anim', anim ? '1' : '0') }, [anim])
  useEffect(() => { applyTextSize(textSize); localStorage.setItem('text-size', textSize) }, [textSize])
  useEffect(() => { localStorage.setItem('canvas-open', canvasOpen ? '1' : '0') }, [canvasOpen])
  useEffect(() => { if (canvasId) localStorage.setItem('canvas', canvasId) }, [canvasId])
  // keep the canvas mounted until its slide-out has finished
  useEffect(() => {
    if (canvasOpen) { setCanvasMounted(true); return }
    const t = setTimeout(() => setCanvasMounted(false), anim ? 260 : 0)
    return () => clearTimeout(t)
  }, [canvasOpen, anim])
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => { localStorage.setItem('sidebar', sidebar ? '1' : '0') }, [sidebar])

  // hash ↔ main page (back button works)
  const main = panes[0]
  useEffect(() => {
    const want = '#/page/' + encodeURIComponent(main)
    if (location.hash !== want) history.pushState(null, '', want)
  }, [main])
  useEffect(() => {
    const on = () => { const t = titleFromHash(); if (t) setPanes([t]) }
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])

  const newNoteRef = useRef<() => void>(() => {})
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'o')) { e.preventDefault(); setSidebar(true); setSearchOpen(true) }
      // Ctrl+N (Alt+N where the browser keeps Ctrl+N for a new window)
      if (e.code === 'KeyN' && !e.metaKey && !e.shiftKey && (e.ctrlKey !== e.altKey)) { e.preventDefault(); newNoteRef.current() }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const openMain = useCallback((title: string) => {
    setPanes([title]); setFocusLast(false)
    if (narrow) setSidebar(false)
  }, [narrow])

  /** Open `title` in a pane to the right of pane `i` (no-op if already open). `focus` moves the cursor there. */
  const openBeside = useCallback((i: number, title: string, focus = true) => {
    if (narrow || canvasOpen) { setPanes([title]); setFocusLast(true); return }
    // at most MAX_PANES; inserting past the limit drops the right-most pane
    setPanes(ps => ps.includes(title) ? ps : [...ps.slice(0, i + 1), title, ...ps.slice(i + 1)].slice(0, MAX_PANES))
    setFocusLast(focus)
  }, [narrow, canvasOpen])

  /** Fade a pane out, then drop it. */
  const closePane = useCallback((title: string) => {
    setClosing(c => [...c, title])
    setTimeout(() => { setPanes(ps => ps.filter(p => p !== title)); setClosing(c => c.filter(t => t !== title)) }, anim ? PANE_OUT_MS : 0)
  }, [anim])

  // switching vault: open panes belonged to the old vault, so start fresh (on a given note, or today)
  const prevVault = useRef<string | null>(null)
  const openAfterSwitch = useRef<string | null>(null)
  useEffect(() => {
    if (!vault) return
    if (prevVault.current && prevVault.current !== vault.id) {
      setPanes([openAfterSwitch.current ?? todayTitle()])
      setFocusLast(false)
    }
    openAfterSwitch.current = null
    prevVault.current = vault.id
  }, [vault])
  const openInVault = useCallback((vaultId: string, title: string) => {
    openAfterSwitch.current = title
    setVault(vaultId)
  }, [setVault])

  // a "+" note that was never edited disappears once it is no longer open
  useEffect(() => {
    for (const p of pages) if (p.local && !panes.includes(p.title)) discardLocal(p.id)
  }, [panes, pages, discardLocal])

  const createUntitled = useCallback(() => {
    let n = 1, title = 'Untitled'
    while (getPage(title)) title = `Untitled ${++n}`
    return createLocal(title).title
  }, [createLocal, getPage])
  const newNote = useCallback(() => openMain(createUntitled()), [createUntitled, openMain])
  newNoteRef.current = newNote

  // a shared link (?vault=…&open=Title) opens that note once, then the address is tidied
  const { vaults } = useStore()
  const sharedOpen = useRef(new URLSearchParams(location.search))
  useEffect(() => {
    const q = sharedOpen.current
    const title = q.get('open')
    if (!title || !vaults.length) return
    const v = q.get('vault')
    sharedOpen.current = new URLSearchParams()
    history.replaceState(null, '', location.pathname + location.hash)
    if (v && vaults.some(x => x.id === v) && v !== vault?.id) openInVault(v, title)
    else setPanes([title])
  }, [vaults, vault, openInVault])
  const newNoteBeside = useCallback((i: number) => openBeside(i, createUntitled()), [createUntitled, openBeside])

  /**
   * A duplicate opens right after the note it copies. With three notes open one has to go: duplicating the first or
   * the middle note drops the last one; duplicating the last drops the first, so the original ends up in the middle.
   */
  const openDuplicate = useCallback((i: number, title: string) => {
    setFocusLast(false)
    if (narrow || canvasOpen) { setPanes([title]); return }
    setPanes(ps => placeDuplicate(ps, i, title))
  }, [narrow, canvasOpen])

  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'
    setTheme(next); localStorage.setItem('theme', next)
  }

  const visible = narrow ? [panes[panes.length - 1]] : canvasOpen ? [panes[0]] : panes
  const showCanvas = !narrow && canvasOpen

  // time spent: every saved note on screen accrues while you're active (see lib/activeTime)
  const onScreen = useRef<string[]>([])
  onScreen.current = visible.map(t => getPage(t)).filter(p => p && !p.local).map(p => p!.id)
  useEffect(() => startActiveTime(() => onScreen.current, addTime), [addTime])

  return (
    <div className="shell">
      <header className="top">
        <div className="top-left">
          <button className="icon-btn" title="Toggle sidebar" onClick={() => setSidebar(s => !s)}><PanelLeft size={18} /></button>
          <span className="brand">Smart Journal</span>
        </div>
        <div className="top-actions">
          {canPublish && vault?.kind === 'public' && <button className="icon-btn" title="Publish this vault" onClick={() => setPublishing(true)}><Globe size={18} /></button>}
          {!narrow && <button className={'icon-btn' + (canvasOpen ? ' on' : '')} title="Toggle canvas" onClick={() => setCanvasOpen(o => !o)}><LayoutGrid size={18} /></button>}
          <button className="icon-btn" onClick={() => setMenu(m => !m)} aria-label="Settings"><Settings size={18} /></button>
        </div>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <div className="menu-email">{email}</div>
            <div className="menu-row" role="group" aria-label="Text size">
              <span>Text size</span>
              <span className="size-pick">
                {TEXT_SIZES.map((t, i) => (
                  <button key={t.id} className={textSize === t.id ? 'on' : ''} aria-pressed={textSize === t.id} title={`${t.label} (${t.px}px)`}
                    onClick={() => setTextSize(t.id)} style={{ fontSize: 12 + i * 3 }}>A</button>
                ))}
              </span>
            </div>
            <button onClick={cycleTheme}>Theme: {theme}</button>
            <button onClick={() => setAnim(a => !a)}>Animations: {anim ? 'on' : 'off'}</button>
            <button onClick={() => { setAiTwoVersions(!aiTwo); setAiTwo(!aiTwo) }} title="Two: compare two AI versions and pick one. One: apply a single response straight away.">AI versions: {aiTwo ? 'two to choose from' : 'one'}</button>
            <button onClick={() => { setAiScoreOn(!aiScore); setAiScore(!aiScore) }} title="Beside AI-written text, show how much of it is still the AI's (%)">AI score: {aiScore ? 'on' : 'off'}</button>
            {aiScore && <button onClick={() => { setAiScoreGemini(!aiGemini); setAiGemini(!aiGemini) }}
              title="Gemini also judges how far the meaning has moved (20% of the score). Off: words and sentences only. Past results are kept and caught up when you switch it back on.">
              Use Gemini to evaluate AI score: {aiGemini ? 'on' : 'off'}</button>}
            <button onClick={() => { setAiWriteFirst(!writeFirst); setWriteFirst(!writeFirst) }}
              title={`The AI tools open in a note once you've typed ${WRITE_FIRST_WORDS} words of your own in it (pasted and AI-written text don't count)`}>
              AI after {WRITE_FIRST_WORDS} words of my own: {writeFirst ? 'on' : 'off'}</button>
            <button onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        )}
      </header>

      <div className={'work' + (narrow ? ' narrow' : '')}>
        <div className={'side-col' + (sidebar ? '' : ' closed')}>
          <Sidebar current={main} open={panes} searchOpen={searchOpen} onSearchOpen={setSearchOpen} onOpen={openMain}
            onOpenBeside={t => openBeside(panes.length - 1, t)} onNew={newNote} />
        </div>
        {narrow && sidebar && <div className="scrim" onClick={() => setSidebar(false)} />}
        <SplitPane storageKey="canvas-split" collapsed={!showCanvas}
          left={canvasMounted && !narrow ? <CanvasPane canvasId={canvasId} onSelectCanvas={setCanvasId} onOpenPage={openMain} /> : null}
          right={
            <div className="panes" data-count={visible.length}>
              {visible.map(title => {
                const i = panes.indexOf(title)
                return (
                  <PagePane
                    key={title}
                    title={title}
                    closing={closing.includes(title)}
                    comments={!narrow && visible.length === 1 && !showCanvas}
                    autoFocus={focusLast && i === panes.length - 1}
                    onOpenLink={t => openBeside(i, t, false)}
                    onNewBeside={narrow || canvasOpen ? undefined : () => newNoteBeside(i)}
                    onDuplicate={t => openDuplicate(i, t)}
                    onNavigate={t => setPanes(ps => ps.map((p, j) => j === i ? t : p))}
                    onRenamed={(from, to) => setPanes(ps => ps.map(p => p === from ? to : p))}
                    onOpenInVault={openInVault}
                    onClose={i > 0 ? () => closePane(title) : undefined}
                  />
                )
              })}
            </div>
          } />
      </div>
      {publishing && vault && <PublishDialog vault={vault} onClose={() => setPublishing(false)} />}
    </div>
  )
}
