import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { openedFromReset, supabase } from './supabase'
import type { AiTool, AppNotice, CanvasItem, Page, PageKind, Vault, VaultKind } from './types'
import { isDailyTitle, normTitle } from './links'
import { extractLinks, relinkTitle, unlinkTitle } from './html'
import { MacVault, closeMacVault, folderAllowed, folderSupported, forgetFolder, getLocalPiece, macVault, openMacVault, putLocalPiece, saveFolder, savedFolder, type MacStatus } from './macVault'

const TOOL_COLS = 'id,name,scope,output,prompt,creativity,single,sort_order,owner,status,author_name'
const PAGE_COLS = 'id,vault_id,title,kind,body,draft,active_seconds,typed_words,created_at,updated_at'

interface Store {
  session: Session | null
  ready: boolean
  /** Signed in through a password-reset link: a new password is needed before anything else. */
  recovering: boolean
  endRecovery: () => void
  /** May publish to the GitHub garden (only its owner). */
  canPublish: boolean
  /** AI tools this person made, in menu order. */
  aiTools: AiTool[]
  /** Tools other people made and the admin published: everyone has them. */
  sharedTools: AiTool[]
  /** The super admin: approves tools people want to share. */
  isAdmin: boolean
  /** Tools waiting for the admin's approval (only the admin sees these). */
  pendingTools: AiTool[]
  /** Ask the admin to publish one of your tools to everyone. */
  submitAiTool: (id: string) => Promise<void>
  /** (Admin) publish a tool that's waiting, to everyone. */
  publishAiTool: (id: string) => Promise<void>
  /** Notices for this person, newest first. */
  notices: AppNotice[]
  markNoticesRead: () => Promise<void>
  saveAiTool: (tool: Omit<AiTool, 'id' | 'sort_order'> & { id?: string }) => Promise<AiTool>
  deleteAiTool: (id: string) => Promise<void>
  moveAiTool: (id: string, by: -1 | 1) => Promise<void>
  /** Every page in every vault. */
  allPages: Page[]
  /** Pages in the current vault. */
  pages: Page[]
  vaults: Vault[]
  vault: Vault | null
  setVault: (id: string) => void
  byId: Map<string, Page>
  /** lower-cased title → page, within the current vault */
  byTitle: Map<string, Page>
  /** lower-cased title → ids of pages that link to it, within the current vault */
  backlinks: Map<string, string[]>
  getPage: (title: string) => Page | undefined
  pagesIn: (vaultId: string) => Page[]
  /** Create the page if it does not exist yet (awaits the insert so the id is usable as a foreign key). */
  ensurePage: (title: string, kind?: PageKind) => Promise<Page>
  /** Optimistic body update; creates the page on first edit; debounced write + link sync. */
  setBody: (title: string, body: string) => void
  /** Local-only page shown in a pane; becomes real on the first title/body edit, discarded otherwise. */
  createLocal: (title: string) => Page
  discardLocal: (id: string) => void
  renamePage: (id: string, title: string) => Promise<void>
  deletePage: (id: string) => Promise<void>
  setDraft: (id: string, draft: boolean) => Promise<void>
  copyPages: (ids: string[], vaultId: string) => Promise<number>
  /** Add time spent to a note (atomic on the server; does not change updated_at). */
  addTime: (id: string, seconds: number) => Promise<void>
  /** Copy a note within its vault as "<title> (copy)"; returns the copy. */
  duplicatePage: (id: string) => Promise<Page>
  /** Put imported notes into a vault (with their links, for backlinks); `onProgress` gets how many are saved. */
  importPages: (vaultId: string, notes: { title: string; body: string; created_at?: string; updated_at?: string }[], onProgress?: (saved: number) => void) => Promise<{ saved: number; failed: string[] }>
  /** Count words typed by hand in a note. */
  addWords: (id: string, words: number) => Promise<void>
  /** A new vault: in the cloud, or (with `dir`) a folder on this Mac — an empty one, or one with Markdown notes in it. */
  createVault: (name: string, kind: VaultKind, dir?: FileSystemDirectoryHandle) => Promise<Vault>
  /** Vaults on this Mac: whether each is open (ready), needs the browser's OK, or needs its folder found. */
  macStatus: Record<string, MacStatus>
  /** Give the browser's OK to a vault folder again (from a click). */
  allowFolder: (vaultId: string) => Promise<boolean>
  /** Point a vault on this Mac at its folder (moved, or opened in another browser). */
  reconnectFolder: (vaultId: string, dir: FileSystemDirectoryHandle) => Promise<void>
  /** Copy a cloud vault into a folder on this Mac and check every note; the cloud copy stays until finishMoveToMac. */
  moveVaultToMac: (vaultId: string, dir: FileSystemDirectoryHandle, onProgress?: (done: number, total: number) => void) => Promise<{ notes: number; canvases: number; pieces: number }>
  /** The vault now lives on this Mac: delete its cloud copy. */
  finishMoveToMac: (vaultId: string, dir: FileSystemDirectoryHandle) => Promise<void>
  updateVault: (id: string, patch: Partial<Vault>) => Promise<void>
  deleteVault: (id: string) => Promise<void>
  reload: () => Promise<void>
  /** Write pending edits now and wait for them. */
  saveNow: () => Promise<void>
  loadItems: (canvasId: string) => Promise<CanvasItem[]>
  addItem: (item: Omit<CanvasItem, 'id'>) => Promise<CanvasItem>
  updateItem: (id: string, patch: Partial<CanvasItem>) => void
  deleteItems: (ids: string[]) => Promise<void>
}

const Ctx = createContext<Store | null>(null)
export const useStore = () => {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}

const SAVE_DELAY = 700
/** Fired on window when a notice arrives (detail: the AppNotice). */
export const NOTICE_EVENT = 'nt-notice'

export function StoreProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [recovering, setRecovering] = useState(openedFromReset)
  const endRecovery = useCallback(() => setRecovering(false), [])
  const [canPublish, setCanPublish] = useState(false)
  // every tool this person can see: their own, everyone's published ones, and (the admin) the ones waiting
  const [tools, setTools] = useState<AiTool[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [notices, setNotices] = useState<AppNotice[]>([])
  const uid = session?.user.id
  const aiTools = useMemo(() => tools.filter(t => !t.owner || t.owner === uid), [tools, uid])
  const sharedTools = useMemo(() => tools.filter(t => t.owner && t.owner !== uid && t.status === 'published'), [tools, uid])
  const pendingTools = useMemo(() => (isAdmin ? tools.filter(t => t.status === 'submitted') : []), [tools, isAdmin])
  const setAiTools = setTools
  const seeding = useRef(false)
  const [allPages, setAllPages] = useState<Page[]>([])
  const [vaults, setVaults] = useState<Vault[]>([])
  const [vaultId, setVaultId] = useState<string | null>(() => localStorage.getItem('vault'))
  const [macStatus, setMacStatus] = useState<Record<string, MacStatus>>({})
  const vaultsRef = useRef<Vault[]>([]); vaultsRef.current = vaults
  /** Is this vault's home a folder on this Mac? */
  const onMacVault = (id: string) => vaultsRef.current.find(v => v.id === id)?.storage === 'mac'
  const mac = (id: string) => { const mv = macVault(id); if (!mv) throw new Error('This vault’s folder on your Mac isn’t open — allow access to it first'); return mv }

  // latest local state, readable synchronously from debounced writers
  const latest = useRef(new Map<string, Page>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const writers = useRef(new Map<string, () => Promise<void>>())
  const inflight = useRef(new Set<string>())   // notes whose save is on its way to the server

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => { if (e === 'PASSWORD_RECOVERY') setRecovering(true); setSession(s) })
    return () => sub.subscription.unsubscribe()
  }, [])

  const reload = useCallback(async () => {
    const [v, p] = await Promise.all([
      supabase.from('nt_vaults').select('*').order('sort_order').order('created_at'),
      supabase.from('nt_pages').select(PAGE_COLS).order('updated_at', { ascending: false }),
    ])
    if (v.error) { console.error(v.error); return }
    if (p.error) { console.error(p.error); return }
    let vs = (v.data ?? []) as Vault[]
    if (!vs.length && !seeding.current) {
      // a new account: start it off with its own private journal
      seeding.current = true
      const first: Vault = {
        id: crypto.randomUUID(), name: 'Journal', kind: 'private',
        site_title: null, site_description: null, site_author: null, site_url: null, sort_order: 0, created_at: new Date().toISOString(),
      }
      const { error } = await supabase.from('nt_vaults').insert(first)
      seeding.current = false
      if (error) console.error('could not create a first vault', error); else vs = [first]
    }
    setVaults(vs)
    vaultsRef.current = vs
    const macIds = new Set(vs.filter(v => v.storage === 'mac').map(v => v.id))
    const rows = ((p.data ?? []) as Page[]).filter(r => !macIds.has(r.vault_id))
    // notes in vaults on this Mac come from their folders, not the cloud
    for (const pg of latest.current.values()) if (macIds.has(pg.vault_id) && !rows.some(r => r.id === pg.id)) rows.push(pg)
    // keep local versions of pages that still have a pending save
    const merged = rows.map(r => (timers.current.has(r.id) || inflight.current.has(r.id)) ? latest.current.get(r.id) ?? r : r)
    for (const [id, pg] of latest.current) if ((timers.current.has(id) || pg.local) && !merged.some(m => m.id === id)) merged.push(pg)
    latest.current = new Map(merged.map(pg => [pg.id, pg]))
    setAllPages(merged)
    openMacVaults(vs)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- vaults on this Mac ----
  const status = (id: string, st: MacStatus) => setMacStatus(m => (m[id] === st ? m : { ...m, [id]: st }))
  /** Put a vault folder's notes in, replacing what was there for that vault. */
  function takeMacPages(vaultId: string, ps: Page[]) {
    const keep = [...latest.current.values()].filter(x => x.vault_id !== vaultId || timers.current.has(x.id))
    const next = [...keep, ...ps.filter(x => !timers.current.has(x.id))]
    latest.current = new Map(next.map(x => [x.id, x]))
    setAllPages(next)
  }
  async function openFolder(v: Vault, dir: FileSystemDirectoryHandle) {
    status(v.id, 'loading')
    const mv = new MacVault(v, dir as never)
    const owner = await mv.ownerId()
    if (owner && owner !== v.id) { status(v.id, 'missing'); throw new Error('That folder belongs to another vault') }
    if (!owner) await mv.claim()
    const ps = await mv.load()
    openMacVault(mv)
    takeMacPages(v.id, ps)
    status(v.id, 'ready')
  }
  /** Open the vaults on this Mac that aren't open yet (quietly: one that needs a click or its folder says so). */
  async function openMacVaults(vs: Vault[]) {
    for (const v of vs.filter(x => x.storage === 'mac')) {
      if (macVault(v.id)) continue
      if (!folderSupported()) { status(v.id, 'unsupported'); continue }
      const dir = await savedFolder(v.id)
      if (!dir) { status(v.id, 'missing'); continue }
      if (!(await folderAllowed(dir))) { status(v.id, 'permission'); continue }
      try { await openFolder(v, dir) } catch (e) { console.error('vault folder', v.name, e); status(v.id, 'error') }
    }
  }
  const allowFolder = useCallback(async (id: string) => {
    const v = vaultsRef.current.find(x => x.id === id), dir = await savedFolder(id)
    if (!v || !dir || !(await folderAllowed(dir, true))) return false
    await openFolder(v, dir)
    return true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const reconnectFolder = useCallback(async (id: string, dir: FileSystemDirectoryHandle) => {
    const v = vaultsRef.current.find(x => x.id === id)
    if (!v) return
    closeMacVault(id)
    await openFolder(v, dir)
    await saveFolder(id, dir as never)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // edits made to the open vault's files in other apps show up here (checked every few seconds while visible)
  // (the vault on screen, which may be the default one rather than one picked: see `vault` below)
  const shownVault = useRef<string | null>(null)
  useEffect(() => {
    let busy = false
    const look = async () => {
      const mv = shownVault.current ? macVault(shownVault.current) : undefined
      if (!mv || busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { upsert, remove } = await mv.changes()
        for (const p of upsert) {
          if (timers.current.has(p.id) || inflight.current.has(p.id)) {
            // changed here and there at once: keep both — theirs as a copy beside ours
            const copy: Page = { ...p, id: crypto.randomUUID(), title: `${p.title} (changed outside the app)` }
            await mv.write(copy)
            upsertLocal(copy)
          } else upsertLocal(p)
        }
        if (remove.length) {
          for (const id of remove) latest.current.delete(id)
          setAllPages(prev => prev.filter(x => !remove.includes(x.id)))
        }
      } catch (e) { console.warn('vault folder: could not check for changes', e) } finally { busy = false }
    }
    const t = window.setInterval(look, 8000)
    document.addEventListener('visibilitychange', look)
    window.addEventListener('focus', look)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', look); window.removeEventListener('focus', look) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!session) { setAllPages([]); setVaults([]); setCanPublish(false); setAiTools([]); setIsAdmin(false); setNotices([]); return }
    reload()
    supabase.from('nt_members').select('can_publish,is_admin').maybeSingle().then(({ data }) => { setCanPublish(!!data?.can_publish); setIsAdmin(!!data?.is_admin) })
    loadTools()
    loadNotices()
    const onVis = () => { if (document.visibilityState === 'visible') { reload(); loadTools(); loadNotices() } else flushAll() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flushAll)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', flushAll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reload])

  // live updates from other devices (skips rows this device is still saving)
  useEffect(() => {
    if (!session) return
    const ch = supabase.channel('nt-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nt_pages' }, payload => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (!id) return
          // a note of a vault on this Mac: its cloud copy going (after a move) is no news here
          const here = latest.current.get(id)
          if (here && onMacVault(here.vault_id)) return
          latest.current.delete(id)
          setAllPages(prev => prev.filter(p => p.id !== id))
          return
        }
        // Update messages can leave fields out: Postgres omits large unchanged values (a long note's body)
        // from them. So never take the message as the whole note — merge only the fields it carries.
        const row = payload.new as Partial<Page> & { id: string }
        if (!row?.id || timers.current.has(row.id) || inflight.current.has(row.id)) return
        if ((row.vault_id && onMacVault(row.vault_id)) || onMacVault(latest.current.get(row.id)?.vault_id ?? '')) return
        const present = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as Partial<Page>
        const cur = latest.current.get(row.id)
        if (!cur) {
          if (typeof row.body === 'string' && typeof row.title === 'string') upsertLocal(row as Page)
          else fetchPage(row.id)   // new to us and incomplete: read the whole row
          return
        }
        const textChanged = (present.body !== undefined && present.body !== cur.body) || (present.title !== undefined && present.title !== cur.title)
        if (!textChanged || (present.updated_at && present.updated_at < cur.updated_at)) {
          // only the time spent (or nothing we show) changed — e.g. another device, or our own save echoing back
          if ((present.active_seconds ?? 0) > (cur.active_seconds ?? 0)) upsertLocal({ ...cur, active_seconds: present.active_seconds })
          if ((present.typed_words ?? 0) > (cur.typed_words ?? 0)) upsertLocal({ ...(latest.current.get(row.id) ?? cur), typed_words: present.typed_words })
          return
        }
        upsertLocal({ ...cur, ...present })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nt_vaults' }, () => { reload() })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  function schedule(key: string, fn: () => Promise<void>) {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    writers.current.set(key, fn)
    timers.current.set(key, setTimeout(() => flush(key), SAVE_DELAY))
  }
  function flush(key: string) {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    timers.current.delete(key)
    const fn = writers.current.get(key)
    writers.current.delete(key)
    return fn?.().catch(e => console.error('save failed', key, e))
  }
  function flushAll() { for (const k of [...timers.current.keys()]) flush(k) }
  /** Write everything still waiting for its debounce, and wait for it (used before a reload). */
  const saveNow = useCallback(async () => { await Promise.all([...timers.current.keys()].map(k => flush(k))) }, [])

  // the current vault: remembered, else the first private one, else the first
  const vault = useMemo(() => {
    if (!vaults.length) return null
    return vaults.find(v => v.id === vaultId) ?? vaults.find(v => v.kind === 'private') ?? vaults[0]
  }, [vaults, vaultId])
  useEffect(() => { if (vault) localStorage.setItem('vault', vault.id) }, [vault])
  shownVault.current = vault?.id ?? null
  const setVault = useCallback((id: string) => setVaultId(id), [])

  const pages = useMemo(() => vault ? allPages.filter(p => p.vault_id === vault.id) : [], [allPages, vault])
  const pagesIn = useCallback((id: string) => allPages.filter(p => p.vault_id === id), [allPages])

  const byId = useMemo(() => new Map(allPages.map(p => [p.id, p])), [allPages])
  const byTitle = useMemo(() => new Map(pages.map(p => [normTitle(p.title), p])), [pages])
  const backlinks = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of pages) for (const t of extractLinks(p.body)) m.set(t, [...(m.get(t) ?? []), p.id])
    return m
  }, [pages])

  const getPage = useCallback((title: string) => byTitle.get(normTitle(title)), [byTitle])

  async function fetchPage(id: string) {
    const { data, error } = await supabase.from('nt_pages').select(PAGE_COLS).eq('id', id).maybeSingle()
    if (!error && data && !timers.current.has(id)) upsertLocal(data as Page)
  }

  function upsertLocal(p: Page) {
    latest.current.set(p.id, p)
    setAllPages(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? p : x) : [p, ...prev])
  }

  const row = (p: Page) => ({ id: p.id, vault_id: p.vault_id, title: p.title, kind: p.kind, body: p.body, draft: p.draft ?? false, updated_at: p.updated_at })

  async function writePage(id: string) {
    inflight.current.add(id)
    try { await writePageNow(id) } finally { inflight.current.delete(id) }
  }

  async function writePageNow(id: string) {
    const p = latest.current.get(id)
    if (!p) return
    if (p.local) return
    if (onMacVault(p.vault_id)) { await mac(p.vault_id).write(p); return }
    const { error } = await supabase.from('nt_pages').upsert(row(p))
    if (error) {
      // 23505 = another device already created this title in this vault; take theirs and retry the body onto it
      if (error.code === '23505') {
        await reload()
        const other = [...latest.current.values()].find(x => x.vault_id === p.vault_id && normTitle(x.title) === normTitle(p.title) && x.id !== id)
        if (other) { latest.current.set(other.id, { ...other, body: p.body }); await writePage(other.id); setAllPages(prev => prev.filter(x => x.id !== id)) }
        return
      }
      throw error
    }
    const links = extractLinks(p.body)
    await supabase.from('nt_links').delete().eq('from_page', p.id)
    if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
  }

  const findLocal = useCallback((title: string) =>
    vault ? [...latest.current.values()].find(p => p.vault_id === vault.id && normTitle(p.title) === normTitle(title)) : undefined, [vault])

  const ensurePage = useCallback(async (title: string, kind?: PageKind) => {
    if (!vault) throw new Error('No vault selected')
    const existing = byTitle.get(normTitle(title)) ?? findLocal(title)
    if (existing) return existing
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), vault_id: vault.id, title: title.trim(), kind: kind ?? (isDailyTitle(title) ? 'daily' : 'note'), body: '', created_at: now, updated_at: now }
    upsertLocal(p)
    if (onMacVault(vault.id)) { await mac(vault.id).write(p); return p }
    const { error } = await supabase.from('nt_pages').insert(row(p))
    if (error) { await reload(); const again = findLocal(title); if (again) return again; throw error }
    return p
  }, [vault, byTitle, findLocal, reload])

  const setBody = useCallback((title: string, body: string) => {
    if (!vault) return
    const now = new Date().toISOString()
    const existing = byTitle.get(normTitle(title)) ?? findLocal(title)
    const p: Page = existing
      ? { ...existing, body, updated_at: now, local: false }
      : { id: crypto.randomUUID(), vault_id: vault.id, title: title.trim(), kind: isDailyTitle(title) ? 'daily' : 'note', body, created_at: now, updated_at: now }
    upsertLocal(p)
    schedule(p.id, () => writePage(p.id))
  }, [vault, byTitle, findLocal])

  const createLocal = useCallback((title: string) => {
    const now = new Date().toISOString()
    const p: Page = { id: crypto.randomUUID(), vault_id: vault?.id ?? '', title: title.trim(), kind: 'note', body: '', created_at: now, updated_at: now, local: true }
    upsertLocal(p)
    return p
  }, [vault])

  const discardLocal = useCallback((id: string) => {
    const p = latest.current.get(id)
    if (!p?.local) return
    latest.current.delete(id)
    setAllPages(prev => prev.filter(x => x.id !== id))
  }, [])

  const renamePage = useCallback(async (id: string, title: string) => {
    const clash = byTitle.get(normTitle(title))
    if (clash && clash.id !== id) throw new Error(`A note called “${clash.title}” already exists in this vault`)
    const p = latest.current.get(id) ?? byId.get(id)
    if (!p) return
    const kind: PageKind = isDailyTitle(title) ? 'daily' : p.kind === 'daily' ? 'note' : p.kind
    const next: Page = { ...p, title: title.trim(), kind, local: false }
    upsertLocal(next)
    if (onMacVault(next.vault_id)) await mac(next.vault_id).write(next)
    else { const { error } = await supabase.from('nt_pages').upsert(row(next)); if (error) throw error }
    // links elsewhere follow the page to its new name
    for (const lid of backlinks.get(normTitle(p.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id && typeof l.body === 'string') setBody(l.title, relinkTitle(l.body, p.title, next.title))
    }
  }, [byTitle, byId, backlinks, setBody])

  const deletePage = useCallback(async (id: string) => {
    const gone = latest.current.get(id) ?? byId.get(id)
    timers.current.delete(id); writers.current.delete(id); latest.current.delete(id)
    setAllPages(prev => prev.filter(p => p.id !== id))
    if (gone && onMacVault(gone.vault_id)) await mac(gone.vault_id).remove(id)
    else { const { error } = await supabase.from('nt_pages').delete().eq('id', id); if (error) throw error }
    // words that linked to the deleted page become plain text again
    if (gone) for (const lid of backlinks.get(normTitle(gone.title)) ?? []) {
      const l = latest.current.get(lid) ?? byId.get(lid)
      if (l && l.id !== id && typeof l.body === 'string') setBody(l.title, unlinkTitle(l.body, gone.title))
    }
  }, [byId, backlinks, setBody])

  const setDraft = useCallback(async (id: string, draft: boolean) => {
    const p = latest.current.get(id) ?? byId.get(id)
    if (!p) return
    upsertLocal({ ...p, draft })
    if (onMacVault(p.vault_id)) { await mac(p.vault_id).write({ ...p, draft }); return }
    const { error } = await supabase.from('nt_pages').update({ draft }).eq('id', id)
    if (error) throw error
  }, [byId])

  /**
   * Copy notes into another vault. The originals stay where they are. A note whose title already exists
   * in the target vault replaces that copy's text (so copying again brings a published copy up to date).
   */
  const copyPages = useCallback(async (ids: string[], target: string) => {
    const now = new Date().toISOString()
    const inTarget = (title: string) => [...latest.current.values()].find(x => x.vault_id === target && !x.local && normTitle(x.title) === normTitle(title))
    const out: Page[] = []
    for (const id of ids) {
      const src = latest.current.get(id) ?? byId.get(id)
      if (!src || src.vault_id === target) continue
      const existing = inTarget(src.title)
      out.push(existing
        ? { ...existing, body: src.body, kind: src.kind, updated_at: now }
        : { id: crypto.randomUUID(), vault_id: target, title: src.title, kind: src.kind, body: src.body, created_at: now, updated_at: now, draft: false })
    }
    if (!out.length) return 0
    if (onMacVault(target)) { for (const p of out) { await mac(target).write(p); upsertLocal(p) } return out.length }
    const { error } = await supabase.from('nt_pages').upsert(out.map(row))
    if (error) throw error
    for (const p of out) upsertLocal(p)
    for (const p of out) {
      const links = extractLinks(p.body)
      await supabase.from('nt_links').delete().eq('from_page', p.id)
      if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
    }
    return out.length
  }, [byId])

  const duplicatePage = useCallback(async (id: string) => {
    const src = latest.current.get(id) ?? byId.get(id)
    if (!src) throw new Error('Note not found')
    // a free title next to the original: "Title (copy)", "Title (copy 2)", …
    const taken = (t: string) => [...latest.current.values()].some(x => x.vault_id === src.vault_id && normTitle(x.title) === normTitle(t))
    let title = `${src.title} (copy)`, n = 1
    while (taken(title)) title = `${src.title} (copy ${++n})`
    // AI-written pieces get ids of their own in the copy, so edits to one copy don't move the other's AI score
    const aiIds = [...new Set([...src.body.matchAll(/data-ai="([0-9a-f-]{36})"/g)].map(m => m[1]))]
    const renamed = new Map(aiIds.map(a => [a, crypto.randomUUID()]))
    const body = src.body.replace(/data-ai="([0-9a-f-]{36})"/g, (_, a: string) => `data-ai="${renamed.get(a)}"`)
    const now = new Date().toISOString()
    // a backup in a public vault is held back from publishing until you say otherwise
    const inPublic = vaults.find(v => v.id === src.vault_id)?.kind === 'public'
    const p: Page = {
      id: crypto.randomUUID(), vault_id: src.vault_id, title, kind: isDailyTitle(title) ? 'daily' : 'note', body,
      draft: inPublic ? true : (src.draft ?? false), created_at: now, updated_at: now, typed_words: src.typed_words ?? 0,
    }
    if (onMacVault(p.vault_id)) {
      await mac(p.vault_id).write(p)
      upsertLocal(p)
      for (const a of aiIds) { const r = await getLocalPiece<Record<string, unknown>>(a); if (r) await putLocalPiece(renamed.get(a)!, { ...r, id: renamed.get(a), page_id: p.id }) }
      return p
    }
    const { error } = await supabase.from('nt_pages').insert({ ...row(p), typed_words: p.typed_words })
    if (error) throw error
    upsertLocal(p)
    const links = extractLinks(body)
    if (links.length) await supabase.from('nt_links').insert(links.map(t => ({ from_page: p.id, to_title: t })))
    if (aiIds.length) {
      const { data } = await supabase.from('nt_ai_pieces').select('id, task, original, seed, seed_meaning, meaning, meaning_of').in('id', aiIds)
      const copies = (data ?? []).map(r => ({ ...r, id: renamed.get(r.id as string)!, page_id: p.id }))
      if (copies.length) { const { error: e2 } = await supabase.from('nt_ai_pieces').insert(copies); if (e2) console.warn('duplicate: AI pieces not copied', e2.message) }
    }
    return p
  }, [byId, vaults])

  const addTime = useCallback(async (id: string, seconds: number) => {
    const here = latest.current.get(id)
    if (here && onMacVault(here.vault_id)) { const next = { ...here, active_seconds: (here.active_seconds ?? 0) + seconds }; upsertLocal(next); schedule(id, () => writePage(id)); return }
    const { data, error } = await supabase.rpc('nt_add_time', { page: id, secs: seconds })
    if (error) throw error
    const p = latest.current.get(id)
    if (p && typeof data === 'number') upsertLocal({ ...p, active_seconds: data })
  }, [])

  const addWords = useCallback(async (id: string, words: number) => {
    // count them straight away (the write-first lock reads this), then take the server's total
    const before = latest.current.get(id)
    if (before) upsertLocal({ ...before, typed_words: (before.typed_words ?? 0) + words })
    if (before && onMacVault(before.vault_id)) { schedule(id, () => writePage(id)); return }
    const { data, error } = await supabase.rpc('nt_add_words', { page: id, words })
    if (error) throw error
    const p = latest.current.get(id)
    if (p && typeof data === 'number') upsertLocal({ ...p, typed_words: data })
  }, [])

  // ---- AI tools people make, and share ----
  const loadTools = useCallback(async () => {
    const { data, error } = await supabase.from('nt_ai_tools').select(TOOL_COLS).order('sort_order').order('created_at')
    if (error) console.warn('AI tools not loaded', error.message); else setTools((data ?? []) as AiTool[])
  }, [])
  const loadNotices = useCallback(async () => {
    const { data, error } = await supabase.from('nt_notifications').select('id,kind,title,body,tool_id,created_at,read_at').order('created_at', { ascending: false }).limit(50)
    if (error) console.warn('notices not loaded', error.message); else setNotices((data ?? []) as AppNotice[])
  }, [])
  // new notices arrive live (a tool to review, a tool approved); the tools they're about change with them
  useEffect(() => {
    if (!uid) return
    const ch = supabase.channel('nt-notices')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'nt_notifications', filter: `owner=eq.${uid}` }, payload => {
        const n = payload.new as AppNotice
        setNotices(ns => (ns.some(x => x.id === n.id) ? ns : [n, ...ns]))
        loadTools()
        window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: n }))
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [uid, loadTools])
  const markNoticesRead = useCallback(async () => {
    const now = new Date().toISOString()
    setNotices(ns => ns.map(n => (n.read_at ? n : { ...n, read_at: now })))
    const { error } = await supabase.from('nt_notifications').update({ read_at: now }).is('read_at', null)
    if (error) console.warn('notices not marked read', error.message)
  }, [])
  const submitAiTool = useCallback(async (id: string) => {
    const { error } = await supabase.rpc('nt_submit_ai_tool', { tool: id })
    if (error) throw error
    await loadTools()
  }, [loadTools])
  const publishAiTool = useCallback(async (id: string) => {
    const { error } = await supabase.rpc('nt_publish_ai_tool', { tool: id })
    if (error) throw error
    await loadTools()
  }, [loadTools])

  const saveAiTool = useCallback(async (tool: Omit<AiTool, 'id' | 'sort_order'> & { id?: string }) => {
    const fields = { name: tool.name.trim(), scope: tool.scope, output: tool.output, prompt: tool.prompt.trim(), creativity: tool.creativity, single: tool.single, updated_at: new Date().toISOString() }
    const { data, error } = tool.id
      ? await supabase.from('nt_ai_tools').update(fields).eq('id', tool.id).select(TOOL_COLS).single()
      : await supabase.from('nt_ai_tools').insert({ ...fields, sort_order: aiTools.length }).select(TOOL_COLS).single()
    if (error) throw error
    const saved = data as AiTool
    setAiTools(ts => (tool.id ? ts.map(t => (t.id === saved.id ? saved : t)) : [...ts, saved]))
    return saved
  }, [aiTools.length])
  const deleteAiTool = useCallback(async (id: string) => {
    const { error } = await supabase.from('nt_ai_tools').delete().eq('id', id)
    if (error) throw error
    setAiTools(ts => ts.filter(t => t.id !== id))
  }, [])
  const moveAiTool = useCallback(async (id: string, by: -1 | 1) => {
    const list = [...aiTools], i = list.findIndex(t => t.id === id), j = i + by
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    const ordered = list.map((t, k) => ({ ...t, sort_order: k }))
    setAiTools(ts => [...ordered, ...ts.filter(t => !ordered.some(o => o.id === t.id))])
    await Promise.all([ordered[i], ordered[j]].map(t => supabase.from('nt_ai_tools').update({ sort_order: t.sort_order }).eq('id', t.id)))
  }, [aiTools])

  // ---- vaults ----
  const createVault = useCallback(async (name: string, kind: VaultKind, dir?: FileSystemDirectoryHandle) => {
    const v: Vault = {
      id: crypto.randomUUID(), name: name.trim(), kind,
      site_title: kind === 'public' ? name.trim() : null, site_description: null, site_author: null, site_url: null,
      sort_order: vaults.length, created_at: new Date().toISOString(), storage: dir ? 'mac' : 'cloud',
    }
    if (dir) {
      // the folder must not already be another vault's
      const owner = await new MacVault(v, dir as never).ownerId()
      if (owner) throw new Error('That folder is already a vault — pick an empty folder, or one with just Markdown notes in it')
    }
    const { error } = await supabase.from('nt_vaults').insert(v)
    if (error) throw error
    setVaults(prev => [...prev, v])
    vaultsRef.current = [...vaultsRef.current, v]
    if (dir) { await saveFolder(v.id, dir as never); await openFolder(v, dir) }
    return v
  }, [vaults.length]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Copy a cloud vault to a folder on this Mac, then read the folder back and check every note matches. */
  const moveVaultToMac = useCallback(async (id: string, dir: FileSystemDirectoryHandle, onProgress?: (done: number, total: number) => void) => {
    const v = vaultsRef.current.find(x => x.id === id)
    if (!v) throw new Error('No such vault')
    if (v.storage === 'mac') throw new Error('This vault is already on your Mac')
    const mv = new MacVault({ ...v, storage: 'mac' }, dir as never)
    const owner = await mv.ownerId()
    if (owner && owner !== id) throw new Error('That folder is already another vault — pick an empty folder')
    await saveNow()
    const notes = [...latest.current.values()].filter(p => p.vault_id === id && !p.local)
    await mv.claim()
    let done = 0
    for (const p of notes) { await mv.write(p); onProgress?.(++done, notes.length) }
    // canvases' cards
    const canvasIds = notes.filter(p => p.kind === 'canvas').map(p => p.id)
    if (canvasIds.length) {
      const { data, error } = await supabase.from('nt_canvas_items').select('id,canvas_id,page_id,text,x,y,w,h,color').in('canvas_id', canvasIds)
      if (error) throw error
      for (const c of canvasIds) await mv.saveCanvas(c, ((data ?? []) as CanvasItem[]).filter(i => i.canvas_id === c))
    }
    // the AI score's records of AI-written pieces in these notes
    const ids = new Set(notes.flatMap(p => [...p.body.matchAll(/data-ai="([0-9a-f-]{36})"/g)].map(m => m[1])))
    const pageIds = notes.map(p => p.id)
    const pieces: Record<string, unknown>[] = []
    for (let i = 0; i < pageIds.length; i += 200) {
      const { data } = await supabase.from('nt_ai_pieces').select('*').in('page_id', pageIds.slice(i, i + 200))
      pieces.push(...(data ?? []))
    }
    const more = [...ids].filter(x => !pieces.some(r => r.id === x))
    for (let i = 0; i < more.length; i += 200) {
      const { data } = await supabase.from('nt_ai_pieces').select('*').in('id', more.slice(i, i + 200))
      pieces.push(...(data ?? []))
    }
    for (const r of pieces) await putLocalPiece(r.id as string, r)
    // read it all back from the folder: every note must be there, exactly
    const check = new MacVault({ ...v, storage: 'mac' }, dir as never)
    const back = new Map((await check.load()).map(p => [p.id, p]))
    const wrong = notes.filter(p => { const b = back.get(p.id); return !b || b.body !== p.body || b.title !== p.title })
    if (wrong.length) throw new Error(`${wrong.length} note(s) didn’t read back the same (e.g. “${wrong[0].title}”) — nothing was changed in the cloud`)
    return { notes: notes.length, canvases: canvasIds.length, pieces: pieces.length }
  }, [saveNow])

  /** After a checked copy: the vault lives on this Mac from now on, and its notes are deleted from the cloud. */
  const finishMoveToMac = useCallback(async (id: string, dir: FileSystemDirectoryHandle) => {
    const v = vaultsRef.current.find(x => x.id === id)
    if (!v) return
    await saveNow()
    const notes = [...latest.current.values()].filter(p => p.vault_id === id)
    const { error } = await supabase.from('nt_vaults').update({ storage: 'mac' }).eq('id', id)
    if (error) throw error
    const moved = { ...v, storage: 'mac' as const }
    vaultsRef.current = vaultsRef.current.map(x => (x.id === id ? moved : x))
    setVaults(prev => prev.map(x => (x.id === id ? moved : x)))
    await saveFolder(id, dir as never)
    await openFolder(moved, dir)
    // the cloud copy goes: notes (their links and canvas cards with them) and the AI score's records
    const ids = notes.map(p => p.id)
    const aiIds = [...new Set(notes.flatMap(p => [...p.body.matchAll(/data-ai="([0-9a-f-]{36})"/g)].map(m => m[1])))]
    for (let i = 0; i < ids.length; i += 200) {
      await supabase.from('nt_ai_pieces').delete().in('page_id', ids.slice(i, i + 200))
      const { error: e } = await supabase.from('nt_pages').delete().in('id', ids.slice(i, i + 200))
      if (e) throw e
    }
    for (let i = 0; i < aiIds.length; i += 200) await supabase.from('nt_ai_pieces').delete().in('id', aiIds.slice(i, i + 200))
  }, [saveNow]) // eslint-disable-line react-hooks/exhaustive-deps

  const importPages = useCallback(async (vaultId: string, notes: { title: string; body: string; created_at?: string; updated_at?: string }[], onProgress?: (saved: number) => void) => {
    const now = new Date().toISOString()
    const ps: Page[] = notes.map(n => ({
      id: crypto.randomUUID(), vault_id: vaultId, title: n.title, kind: isDailyTitle(n.title) ? 'daily' : 'note', body: n.body, draft: false,
      created_at: n.created_at ?? now, updated_at: n.updated_at ?? n.created_at ?? now,
    }))
    if (onMacVault(vaultId)) {
      const failed: string[] = []
      let n = 0
      for (const p of ps) { try { await mac(vaultId).write(p); upsertLocal(p) } catch { failed.push(p.title) } onProgress?.(++n) }
      return { saved: ps.length - failed.length, failed }
    }
    // in batches, so a big graph doesn't make one huge request; a batch that fails is tried a note at a time, so
    // one note the database won't take doesn't stop the rest
    const saved: Page[] = [], failed: string[] = []
    const put = (batch: Page[]) => supabase.from('nt_pages').insert(batch.map(p => ({ ...row(p), created_at: p.created_at })))
    for (let i = 0; i < ps.length; i += 100) {
      const batch = ps.slice(i, i + 100)
      const { error } = await put(batch)
      if (!error) saved.push(...batch)
      else {
        console.warn('import: a batch failed, trying its notes one by one', error.message)
        for (const p of batch) { const { error: e } = await put([p]); if (e) failed.push(p.title); else saved.push(p) }
      }
      onProgress?.(i + batch.length)
    }
    if (!saved.length) throw new Error(`None of the notes could be saved${failed.length ? ` (e.g. “${failed[0]}”)` : ''}`)
    const links = saved.flatMap(p => extractLinks(p.body).map(t => ({ from_page: p.id, to_title: t })))
    for (let i = 0; i < links.length; i += 500) {
      const { error } = await supabase.from('nt_links').insert(links.slice(i, i + 500))
      if (error) console.warn('import: some links not saved', error.message)
    }
    await reload()
    return { saved: saved.length, failed }
  }, [reload])

  const updateVault = useCallback(async (id: string, patch: Partial<Vault>) => {
    setVaults(prev => prev.map(v => v.id === id ? { ...v, ...patch } : v))
    const { error } = await supabase.from('nt_vaults').update(patch).eq('id', id)
    if (error) throw error
  }, [])

  const deleteVault = useCallback(async (id: string) => {
    const { error } = await supabase.from('nt_vaults').delete().eq('id', id)
    if (error) throw error
    // a vault on this Mac: its folder and files stay where they are
    if (onMacVault(id)) { closeMacVault(id); await forgetFolder(id) }
    setVaults(prev => prev.filter(v => v.id !== id))
    setAllPages(prev => prev.filter(p => p.vault_id !== id))
    setVaultId(null)
  }, [])

  // ---- canvas items ----
  /** The vault on this Mac a canvas is in, if it is. */
  const macCanvas = (canvasId: string) => { const c = latest.current.get(canvasId); return c && onMacVault(c.vault_id) ? mac(c.vault_id) : null }
  const saveCanvasSoon = (canvasId: string) => {
    const mv = macCanvas(canvasId)
    if (mv) schedule('canvas:' + canvasId, () => mv.saveCanvas(canvasId, [...items.current.values()].filter(i => i.canvas_id === canvasId)))
  }
  const loadItems = useCallback(async (canvasId: string) => {
    const mv = macCanvas(canvasId)
    if (mv) { const list = await mv.loadCanvas(canvasId); for (const it of list) items.current.set(it.id, it); return list }
    const { data, error } = await supabase.from('nt_canvas_items').select('id,canvas_id,page_id,text,x,y,w,h,color').eq('canvas_id', canvasId)
    if (error) throw error
    return (data ?? []) as CanvasItem[]
  }, [])

  const items = useRef(new Map<string, CanvasItem>())

  const addItem = useCallback(async (item: Omit<CanvasItem, 'id'>) => {
    const full: CanvasItem = { ...item, id: crypto.randomUUID() }
    items.current.set(full.id, full)
    if (macCanvas(full.canvas_id)) { saveCanvasSoon(full.canvas_id); return full }
    const { error } = await supabase.from('nt_canvas_items').insert(full)
    if (error) throw error
    return full
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    const cur = items.current.get(id)
    items.current.set(id, { ...(cur ?? { id }), ...patch } as CanvasItem)
    const canvasId = items.current.get(id)?.canvas_id
    if (canvasId && macCanvas(canvasId)) { saveCanvasSoon(canvasId); return }
    schedule('item:' + id, async () => {
      const it = items.current.get(id)
      if (!it) return
      const { error } = await supabase.from('nt_canvas_items').update({ ...patch, ...pick(it, Object.keys(patch) as (keyof CanvasItem)[]), updated_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    })
  }, [])

  const deleteItems = useCallback(async (ids: string[]) => {
    const canvases = new Set(ids.map(id => items.current.get(id)?.canvas_id).filter((c): c is string => !!c && !!macCanvas(c)))
    if (canvases.size) { for (const id of ids) items.current.delete(id); canvases.forEach(saveCanvasSoon); return }
    for (const id of ids) { items.current.delete(id); timers.current.delete('item:' + id); writers.current.delete('item:' + id) }
    const { error } = await supabase.from('nt_canvas_items').delete().in('id', ids)
    if (error) throw error
  }, [])

  const value: Store = {
    session, ready, recovering, endRecovery, canPublish, aiTools, sharedTools, isAdmin, pendingTools, submitAiTool, publishAiTool, notices, markNoticesRead, saveAiTool, deleteAiTool, moveAiTool, allPages, pages, vaults, vault, setVault, byId, byTitle, backlinks, getPage, pagesIn,
    ensurePage, setBody, createLocal, discardLocal, renamePage, deletePage, setDraft, copyPages, duplicatePage, importPages, addTime, addWords,
    createVault, updateVault, deleteVault, reload, macStatus, allowFolder, reconnectFolder, moveVaultToMac, finishMoveToMac, saveNow, loadItems, addItem, updateItem, deleteItems,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) out[k] = o[k]
  return out
}
