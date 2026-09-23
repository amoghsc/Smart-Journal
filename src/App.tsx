import { useCallback, useEffect, useRef, useState } from 'react'
import { Globe, LayoutGrid, PanelLeft, Settings } from 'lucide-react'
import { useStore } from './lib/store'
import { supabase } from './lib/supabase'
import { todayTitle } from './lib/links'
import { Login } from './views/Login'
import { PagePane } from './views/PagePane'
import { Sidebar } from './views/Sidebar'
import { CanvasPane } from './views/CanvasPane'
import { PublishDialog } from './views/PublishDialog'
import { SplitPane } from './components/SplitPane'

type Theme = 'system' | 'light' | 'dark'
const applyTheme = (t: Theme) => { if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t }
const applyAnim = (on: boolean) => { if (on) delete document.documentElement.dataset.anim; else document.documentElement.dataset.anim = 'off' }
const PANE_OUT_MS = 180

const MAX_PANES = 3

const titleFromHash = () => {
  const m = /^#\/page\/(.+)$/.exec(location.hash)
  return m ? decodeURIComponent(m[1]) : null
}

export default function App() {
  const { session, ready } = useStore()
  if (!ready) return <div className="center-screen muted">Loading…</div>
  if (!session) return <Login />
  return <Workspace email={session.user.email ?? ''} />
}

function Workspace({ email }: { email: string }) {
  const { pages, vault, setVault, getPage, createLocal, discardLocal } = useStore()
  // open pages, left to right; the first is the "main" one the sidebar controls
  const [panes, setPanes] = useState<string[]>(() => [todayTitle()])
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('sidebar') !== '0')
  const [searchOpen, setSearchOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'system')
  const [anim, setAnim] = useState(() => localStorage.getItem('anim') !== '0')
  const [focusLast, setFocusLast] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [closing, setClosing] = useState<string[]>([])
  // canvas sits between the sidebar and the note; while it is open only the left-most note shows
  const [canvasOpen, setCanvasOpen] = useState(() => localStorage.getItem('canvas-open') === '1')
  const [canvasMounted, setCanvasMounted] = useState(canvasOpen)
  const [canvasId, setCanvasId] = useState<string | null>(() => localStorage.getItem('canvas'))

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => { applyAnim(anim); localStorage.setItem('anim', anim ? '1' : '0') }, [anim])
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

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'o')) { e.preventDefault(); setSidebar(true); setSearchOpen(true) }
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
  const newNoteBeside = useCallback((i: number) => openBeside(i, createUntitled()), [createUntitled, openBeside])

  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'
    setTheme(next); localStorage.setItem('theme', next)
  }

  const visible = narrow ? [panes[panes.length - 1]] : canvasOpen ? [panes[0]] : panes
  const showCanvas = !narrow && canvasOpen

  return (
    <div className="shell">
      <header className="top">
        <div className="top-left">
          <button className="icon-btn" title="Toggle sidebar" onClick={() => setSidebar(s => !s)}><PanelLeft size={18} /></button>
          <span className="brand">Journal</span>
        </div>
        <div className="top-actions">
          {vault?.kind === 'public' && <button className="icon-btn" title="Publish this vault" onClick={() => setPublishing(true)}><Globe size={18} /></button>}
          {!narrow && <button className={'icon-btn' + (canvasOpen ? ' on' : '')} title="Toggle canvas" onClick={() => setCanvasOpen(o => !o)}><LayoutGrid size={18} /></button>}
          <button className="icon-btn" onClick={() => setMenu(m => !m)} aria-label="Settings"><Settings size={18} /></button>
        </div>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <div className="menu-email">{email}</div>
            <button onClick={cycleTheme}>Theme: {theme}</button>
            <button onClick={() => setAnim(a => !a)}>Animations: {anim ? 'on' : 'off'}</button>
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
