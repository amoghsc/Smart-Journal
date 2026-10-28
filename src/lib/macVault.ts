import { noteToMarkdown } from './export'
import { mdToNoteHtml } from './importNotes'
import { isDailyTitle, prettyDate } from './links'
import type { CanvasItem, Page, Vault } from './types'

/**
 * Vaults on this Mac: a vault that is a folder of Markdown files instead of rows in the cloud.
 *
 *   <folder>/Journal/2026/2026-10-28.md      a day
 *   <folder>/Notes/My note.md                any other note (notes found elsewhere in the folder stay where they are)
 *   <folder>/.smartjournal/vault.json        which vault this folder is
 *   <folder>/.smartjournal/notes/<id>.json   what Markdown can't hold: the note exactly as the app has it (comments,
 *                                            AI marks, highlights…), time spent, words typed
 *   <folder>/.smartjournal/canvas/<id>.json  a canvas's cards
 *   <folder>/_Deleted/                       notes deleted in the app (nothing is ever destroyed here)
 *
 * Each note file starts with a few details (front matter) and is plain Markdown after that, so any editor opens it.
 * The app reads its own copy (the .json) unless the .md was changed by something else since the app wrote it — then
 * the .md wins and is read back in. The folder is watched, so edits made elsewhere show up while the app is open.
 *
 * Needs the File System Access API (Chrome, Comet, Edge, Arc… on a computer).
 */

type Dir = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  values?: () => AsyncIterable<FileSystemHandle>
}

export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window
export type MacStatus = 'loading' | 'ready' | 'permission' | 'missing' | 'unsupported' | 'error'

const META = '.smartjournal'
const SKIP = new Set([META, '_Deleted', '.obsidian', '.trash', '.git', 'node_modules', 'logseq'])

// ---- a small IndexedDB store: folder handles (they can't go anywhere else) and AI-score pieces of Mac notes ----

function idb<T>(store: 'handles' | 'pieces', mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('smart-journal-mac', 1)
    open.onupgradeneeded = () => { open.result.createObjectStore('handles'); open.result.createObjectStore('pieces') }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(store, mode)
      const req = f(tx.objectStore(store))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => open.result.close()
    }
  })
}
export const savedFolder = (vaultId: string) => idb<Dir | undefined>('handles', 'readonly', s => s.get(vaultId)).catch(() => undefined)
export const saveFolder = (vaultId: string, dir: Dir) => idb<void>('handles', 'readwrite', s => s.put(dir, vaultId))
export const forgetFolder = (vaultId: string) => idb<void>('handles', 'readwrite', s => s.delete(vaultId))
export const getLocalPiece = <T>(id: string) => idb<T | undefined>('pieces', 'readonly', s => s.get(id)).catch(() => undefined)
export const putLocalPiece = (id: string, row: unknown) => idb<void>('pieces', 'readwrite', s => s.put(row, id))

/** Ask for a folder (a click must lead here). */
export async function pickFolder(): Promise<Dir | null> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<Dir> }).showDirectoryPicker
  try { return await pick({ id: 'smart-journal-vault', mode: 'readwrite', startIn: 'documents' }) } catch { return null }
}
/** May the app write to `dir` now? `ask`: show the browser's prompt if needed (needs a click). */
export async function folderAllowed(dir: Dir, ask = false): Promise<boolean> {
  if (!dir.queryPermission) return true
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return ask && !!dir.requestPermission && (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'
}

// ---- files ----

async function dirAt(root: Dir, parts: string[], create: boolean): Promise<Dir | null> {
  let d: Dir = root
  for (const p of parts) {
    try { d = (await d.getDirectoryHandle(p, { create })) as Dir } catch { return null }
  }
  return d
}
async function writeText(root: Dir, path: string[], text: string): Promise<File> {
  const d = await dirAt(root, path.slice(0, -1), true)
  const fh = await d!.getFileHandle(path[path.length - 1], { create: true })
  const w = await fh.createWritable()
  await w.write(text)
  await w.close()
  return fh.getFile()
}
async function readFile(root: Dir, path: string[]): Promise<File | null> {
  const d = await dirAt(root, path.slice(0, -1), false)
  try { return d ? await (await d.getFileHandle(path[path.length - 1])).getFile() : null } catch { return null }
}
async function removeFile(root: Dir, path: string[]) {
  const d = await dirAt(root, path.slice(0, -1), false)
  try { await d?.removeEntry(path[path.length - 1]) } catch { /* already gone */ }
}
/** Every Markdown file under `root` (not in the app's own or other tools' hidden folders), with its path. */
async function markdownFiles(root: Dir): Promise<{ path: string[]; file: File }[]> {
  const out: { path: string[]; file: File }[] = []
  const walk = async (d: Dir, at: string[]) => {
    for await (const h of d.values!()) {
      if (h.kind === 'directory') { if (!SKIP.has(h.name) && !h.name.startsWith('.')) await walk(h as Dir, [...at, h.name]) }
      else if (/\.md$/i.test(h.name)) out.push({ path: [...at, h.name], file: await (h as FileSystemFileHandle).getFile() })
    }
  }
  await walk(root, [])
  return out
}

const safe = (s: string) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled')
const key = (path: string[]) => path.join('/').toLowerCase()
export function textHash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36) + s.length.toString(36)
}
/** The same id for the same file every time (a file the app hasn't given an id yet). */
async function stableId(path: string[]) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key(path))))
  const h = [...d.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// front matter: "key: value" lines; values the app writes may be JSON strings
function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.startsWith('"')) { try { v = JSON.parse(v) } catch { /* as written */ } }
    meta[kv[1]] = v
  }
  return { meta, body: md.slice(m[0].length) }
}
const yaml = (s: string) => (/^[\w .,'()&+-]*$/.test(s) && !/^\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s))

/** A note's file: its details, then the note as Markdown. */
function noteFile(p: Page): string {
  const daily = isDailyTitle(p.title)
  return [
    '---',
    `title: ${yaml(daily ? prettyDate(p.title) : p.title)}`,
    `type: ${daily ? 'journal' : 'note'}`,
    daily ? `date: ${p.title}` : null,
    `created: ${p.created_at}`,
    `updated: ${p.updated_at}`,
    p.draft ? 'publish: no' : null,
    `id: ${p.id}`,
    '---',
    '',
  ].filter(l => l != null).join('\n') + noteToMarkdown(p.title, p.body, { heading: false })
}

/** What the app keeps beside each note file. */
interface Side {
  v: 1; id: string; title: string; kind: Page['kind']; body: string; created_at: string; updated_at: string
  active_seconds?: number; typed_words?: number; draft?: boolean
  /** where its .md is, and a fingerprint of the .md as the app last wrote it */
  path: string[] | null; mdHash: string | null
}
interface Known { page: Page; path: string[] | null; mdHash: string | null; modified: number }

export interface FolderChanges { upsert: Page[]; remove: string[] }

export class MacVault {
  readonly known = new Map<string, Known>()   // by note id
  private byPath = new Map<string, string>()  // .md path → note id
  private queue = Promise.resolve()

  vault: Vault
  dir: Dir
  constructor(vault: Vault, dir: Dir) { this.vault = vault; this.dir = dir }

  get folderName() { return this.dir.name }

  /** Does the folder belong to this vault (or to no vault yet)? */
  async ownerId(): Promise<string | null> {
    const f = await readFile(this.dir, [META, 'vault.json'])
    try { return f ? (JSON.parse(await f.text()).id as string) : null } catch { return null }
  }
  async claim() {
    await writeText(this.dir, [META, 'vault.json'], JSON.stringify({ id: this.vault.id, name: this.vault.name, app: 'Smart Journal', claimed: new Date().toISOString() }, null, 2))
    await writeText(this.dir, [META, 'README.txt'], 'This folder holds what Smart Journal needs beyond the Markdown files: each note exactly as the app has it (comments, AI marks, time spent) and canvas layouts. Leave it be; deleting it only loses those extras.\n')
  }

  /** Read the whole vault. Notes changed outside the app since it last wrote them are read from their Markdown. */
  async load(): Promise<Page[]> {
    this.known.clear(); this.byPath.clear()
    const sides = new Map<string, Side>()
    const notesDir = await dirAt(this.dir, [META, 'notes'], false)
    if (notesDir) for await (const h of notesDir.values!()) {
      if (h.kind !== 'file' || !h.name.endsWith('.json')) continue
      try { const s = JSON.parse(await (await (h as FileSystemFileHandle).getFile()).text()) as Side; if (s?.id) sides.set(s.id, s) } catch { /* unreadable: the .md still has the note */ }
    }
    const sideByPath = new Map([...sides.values()].filter(s => s.path).map(s => [key(s.path!), s]))
    const seen = new Set<string>()
    for (const { path, file } of await markdownFiles(this.dir)) {
      const text = await file.text()
      const { meta } = frontMatter(text)
      const id = (meta.id && /^[0-9a-f-]{36}$/i.test(meta.id) ? meta.id : null) ?? sideByPath.get(key(path))?.id ?? await stableId(path)
      if (seen.has(id)) continue   // a copy of a file made elsewhere: the first one counts
      seen.add(id)
      const side = sides.get(id)
      const h = textHash(text)
      const fromApp = !!side && side.mdHash === h
      const page = fromApp ? this.fromSide(side) : await this.fromMarkdown(text, path, id, side, file.lastModified)
      this.track(page, path, h, file.lastModified)
    }
    // notes without a Markdown file: canvases (they have none), or notes whose file was deleted in Finder
    for (const s of sides.values()) {
      if (seen.has(s.id)) continue
      if (s.kind === 'canvas') { this.track(this.fromSide(s), null, null, 0); continue }
      await this.discard(s)
    }
    this.dedupeTitles()
    await this.resolveLinks(new Set(this.known.keys()))
    return [...this.known.values()].map(k => k.page)
  }

  /**
   * Obsidian writes links with folders ("[[Projects/Plan]]" for Plan.md). A link that matches no note but whose last
   * part does is pointed at that note (a title may itself contain "/", so only then).
   */
  private async resolveLinks(ids: Set<string>) {
    if (!ids.size) return
    const titles = new Map([...this.known.values()].map(k => [k.page.title.toLowerCase(), k.page.title]))
    for (const id of ids) {
      const k = this.known.get(id)
      if (!k) continue
      const body = k.page.body.replace(/<a class="wikilink" data-title="([^"]*)">([^<]*)<\/a>/g, (all, t: string) => {
        const plain = t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        if (titles.has(plain.toLowerCase()) || !plain.includes('/')) return all
        const real = titles.get(plain.split('/').pop()!.trim().toLowerCase())
        if (!real) return all
        const e = real.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<a class="wikilink" data-title="${e}">${e}</a>`
      })
      // (kept, so the next opening reads it resolved)
      if (body !== k.page.body) { k.page = { ...k.page, body }; await this.writeSide(k.page, k.path, k.mdHash) }
    }
  }

  private fromSide(s: Side): Page {
    return { id: s.id, vault_id: this.vault.id, title: s.title, kind: s.kind, body: s.body, created_at: s.created_at, updated_at: s.updated_at,
      active_seconds: s.active_seconds ?? 0, typed_words: s.typed_words ?? 0, draft: s.draft ?? false }
  }
  /** A note written or changed outside the app: its Markdown is the truth; what the app knew is kept where it can be. */
  private async fromMarkdown(text: string, path: string[], id: string, side: Side | undefined, modified: number): Promise<Page> {
    const { meta, body } = frontMatter(text)
    const name = path[path.length - 1].replace(/\.md$/i, '')
    const day = /^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? '') ? meta.date : /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : null
    const title = day ?? (meta.title || side?.title || name)
    const when = new Date(modified || Date.now()).toISOString()
    const page: Page = {
      id, vault_id: this.vault.id, title, kind: day ? 'daily' : 'note', body: mdToNoteHtml(body),
      created_at: side?.created_at ?? meta.created ?? when, updated_at: when,
      active_seconds: side?.active_seconds ?? 0, typed_words: side?.typed_words ?? 0, draft: side?.draft ?? meta.publish === 'no',
    }
    // remember it as read, so it isn't converted again next time
    await this.writeSide(page, path, textHash(text))
    return page
  }
  private track(page: Page, path: string[] | null, mdHash: string | null, modified: number) {
    const before = this.known.get(page.id)
    if (before?.path) this.byPath.delete(key(before.path))
    this.known.set(page.id, { page, path, mdHash, modified })
    if (path) this.byPath.set(key(path), page.id)
  }
  /** Titles must be unique in a vault; files elsewhere can clash ("Ideas" in two folders): the later gets " (2)". */
  private dedupeTitles() {
    const used = new Set<string>()
    for (const k of this.known.values()) {
      let t = k.page.title, n = 1
      while (used.has(t.toLowerCase())) t = `${k.page.title} (${++n})`
      used.add(t.toLowerCase())
      if (t !== k.page.title) k.page = { ...k.page, title: t }
    }
  }

  private async writeSide(p: Page, path: string[] | null, mdHash: string | null) {
    const side: Side = { v: 1, id: p.id, title: p.title, kind: p.kind, body: p.body, created_at: p.created_at, updated_at: p.updated_at,
      active_seconds: p.active_seconds ?? 0, typed_words: p.typed_words ?? 0, draft: p.draft ?? false, path, mdHash }
    await writeText(this.dir, [META, 'notes', `${p.id}.json`], JSON.stringify(side))
  }

  /** Where a new note's file goes: days by year in Journal/, everything else in Notes/. A renamed note stays in its folder. */
  private pathFor(p: Page, was: string[] | null): string[] {
    if (isDailyTitle(p.title)) return ['Journal', p.title.slice(0, 4), `${p.title}.md`]
    const folder = was && !(was[0] === 'Journal' && /^\d{4}-\d{2}-\d{2}\.md$/.test(was[was.length - 1])) ? was.slice(0, -1) : ['Notes']
    let name = `${safe(p.title)}.md`, n = 1
    while (this.byPath.has(key([...folder, name])) && this.byPath.get(key([...folder, name])) !== p.id) name = `${safe(p.title)} (${++n}).md`
    return [...folder, name]
  }

  /** Save a note (in order with other saves to this vault). Its Markdown is only rewritten when it changes. */
  write(p: Page): Promise<void> {
    const job = this.queue.then(async () => {
      const before = this.known.get(p.id)
      if (p.kind === 'canvas') { await this.writeSide(p, null, null); this.track(p, null, null, 0); return }
      const wasPath = before?.path ?? null
      const path = before && before.page.title === p.title && wasPath ? wasPath : this.pathFor(p, wasPath)
      const md = noteFile(p), h = textHash(md)
      let modified = before?.modified ?? 0
      const moved = !!wasPath && key(wasPath) !== key(path)
      if (!before || before.mdHash !== h || moved || !wasPath) modified = (await writeText(this.dir, path, md)).lastModified
      await this.writeSide(p, path, h)
      if (moved) await removeFile(this.dir, wasPath!)
      this.track(p, path, h, modified)
    })
    this.queue = job.catch(() => {})
    return job
  }

  /** Delete a note: its file moves to _Deleted/ (kept), its extras to .smartjournal/trash/. */
  remove(id: string): Promise<void> {
    const job = this.queue.then(async () => {
      const k = this.known.get(id)
      if (!k) return
      this.known.delete(id)
      if (k.path) {
        this.byPath.delete(key(k.path))
        const f = await readFile(this.dir, k.path)
        if (f) { await writeText(this.dir, ['_Deleted', `${new Date().toISOString().slice(0, 10)} ${k.path[k.path.length - 1]}`], await f.text()); await removeFile(this.dir, k.path) }
      }
      await this.trashSide(id)
    })
    this.queue = job.catch(() => {})
    return job
  }
  private async trashSide(id: string) {
    const f = await readFile(this.dir, [META, 'notes', `${id}.json`])
    if (f) { await writeText(this.dir, [META, 'trash', `${id}.json`], await f.text()); await removeFile(this.dir, [META, 'notes', `${id}.json`]) }
  }
  private async discard(s: Side) { await this.trashSide(s.id) }

  /** What changed in the folder since it was last looked at: notes edited, added or deleted outside the app. */
  async changes(): Promise<FolderChanges> {
    const upsert: Page[] = [], remove: string[] = []
    const files = await markdownFiles(this.dir)
    const present = new Set(files.map(f => key(f.path)))
    for (const { path, file } of files) {
      const id = this.byPath.get(key(path))
      const k = id ? this.known.get(id) : undefined
      if (k && k.modified === file.lastModified) continue
      const text = await file.text(), h = textHash(text)
      if (k && k.mdHash === h) { k.modified = file.lastModified; continue }   // touched, not changed
      const { meta } = frontMatter(text)
      const newId = k?.page.id ?? (meta.id && /^[0-9a-f-]{36}$/i.test(meta.id) && !this.known.has(meta.id) ? meta.id : await stableId(path))
      const page = await this.fromMarkdown(text, path, newId, k ? this.sideOf(k) : undefined, file.lastModified)
      this.track(page, path, h, file.lastModified)
      upsert.push(page)
    }
    for (const [id, k] of [...this.known]) {
      if (!k.path || present.has(key(k.path))) continue
      this.known.delete(id); this.byPath.delete(key(k.path))
      await this.trashSide(id)
      remove.push(id)
    }
    if (upsert.length) { this.dedupeTitles(); await this.resolveLinks(new Set(upsert.map(p => p.id))) }
    return { upsert: upsert.map(p => this.known.get(p.id)?.page ?? p), remove }
  }
  private sideOf(k: Known): Side {
    const p = k.page
    return { v: 1, id: p.id, title: p.title, kind: p.kind, body: p.body, created_at: p.created_at, updated_at: p.updated_at, active_seconds: p.active_seconds, typed_words: p.typed_words, draft: p.draft, path: k.path, mdHash: k.mdHash }
  }

  // ---- canvases ----
  async loadCanvas(canvasId: string): Promise<CanvasItem[]> {
    const f = await readFile(this.dir, [META, 'canvas', `${canvasId}.json`])
    try { return f ? (JSON.parse(await f.text()).items as CanvasItem[]) : [] } catch { return [] }
  }
  saveCanvas(canvasId: string, items: CanvasItem[]): Promise<void> {
    const job = this.queue.then(async () => { await writeText(this.dir, [META, 'canvas', `${canvasId}.json`], JSON.stringify({ v: 1, items })) })
    this.queue = job.catch(() => {})
    return job
  }
}

// ---- the vaults on this Mac that are open now ----

const open = new Map<string, MacVault>()
export const macVault = (vaultId: string) => open.get(vaultId)
export const openMacVault = (mv: MacVault) => { open.set(mv.vault.id, mv) }
export const closeMacVault = (vaultId: string) => { open.delete(vaultId) }
/** Is this note in a vault on this Mac (so its AI pieces stay on this Mac too)? */
export const onMac = (pageId: string | undefined) => !!pageId && [...open.values()].some(v => v.known.has(pageId))
export const isMacVault = (v: Vault | null | undefined) => v?.storage === 'mac'
