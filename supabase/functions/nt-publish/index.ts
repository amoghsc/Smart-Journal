// Publishes a public vault's exported site to one GitHub repo.
//
// Security model:
//  - The GitHub token lives only in this function's secrets. It never reaches the browser.
//  - The target repo is fixed by a secret too, so a caller cannot redirect a publish elsewhere.
//  - The caller must be allowed to publish (nt_members.can_publish — the garden repo is Amogh's) and own the
//    vault (reads go through RLS with their own JWT), and the vault must be `public` in the database — a private
//    vault is refused here, not just hidden in the UI.
//  - The vault's folder is derived here from its name in the database; the caller can only write the
//    shared root files and files inside that one folder (strict path allowlist).
//  - Several people can publish into the same garden. The new tree = the uploaded files + the folders of every
//    other published vault (anyone's, via nt_published_vaults), kept as they are. Folder names are unique across
//    everyone: a vault whose folder is taken is refused.
//    Anything else (this vault's stale notes, a folder left by a rename or a deleted vault) is dropped,
//    so the repo always mirrors what is published. Every publish is one auditable commit.
//
// Secrets: GITHUB_TOKEN (fine-grained PAT: one repo, Contents read/write), GITHUB_REPO ("owner/name"),
// optional GITHUB_BRANCH (default "main").
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://amoghsc.github.io', 'http://localhost:5183']
const ROOT_FILE_RE = /^(index\.html|style\.css|script\.js|README\.md|\.nojekyll)$/
const VAULT_FILE_RE = /^(index\.html|search\.json|feed\.xml|[\p{L}\p{M}\p{N}-]{1,160}\/index\.html)$/u
const MAX_FILES = 5000
const MAX_BYTES = 25 * 1024 * 1024
const GH = 'https://api.github.com'

/** Identical to slugFor in src/lib/publish.ts — keep them in step. */
function slugFor(title: string): string {
  const s = title.toLowerCase().normalize('NFKD')
    .replace(/([a-z])\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 120).replace(/-$/, '')
  return s || 'note'
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

function pagesUrl(repo: string): string {
  const [owner, name] = repo.split('/')
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name}/` : `https://${owner}.github.io/${name}/`
}

async function gh(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'smart-journal-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data }
}

async function headSha(token: string, repo: string, branch: string): Promise<string | null> {
  const r = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`)
  if (r.status === 200) return r.data.object.sha
  if (r.status === 404 || r.status === 409) return null   // branch missing, or repo still empty
  if (r.status === 401 || r.status === 403) throw new HttpError(502, 'GitHub rejected the token — it may have expired or lack access to this repo')
  throw new HttpError(502, `GitHub: could not read branch (${r.status})`)
}

interface TreeEntry { path: string; mode: string; type: 'blob'; content?: string; sha?: string }

/** Commit a new tree: `files` as uploaded, plus every existing file inside one of the `keep` folders. */
async function publish(token: string, repo: string, branch: string, files: Record<string, string>, keep: Set<string>, message: string) {
  let parent = await headSha(token, repo, branch)
  if (!parent) {
    // the Git Data API cannot write to an empty repo, so seed it through the Contents API first
    const init = await gh(token, 'PUT', `/repos/${repo}/contents/README.md`, {
      message: 'Initialise site', branch, content: btoa('Published by Smart Journal.\n'),
    })
    if (init.status >= 300) throw new HttpError(502, `GitHub: could not initialise the repo (${init.status})`)
    parent = await headSha(token, repo, branch)
    if (!parent) throw new HttpError(502, 'GitHub: branch still missing after initialising')
  }

  const current = await gh(token, 'GET', `/repos/${repo}/git/commits/${parent}`)
  if (current.status !== 200) throw new HttpError(502, `GitHub: could not read the latest commit (${current.status})`)

  const entries: TreeEntry[] = Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }))
  if (keep.size) {
    const old = await gh(token, 'GET', `/repos/${repo}/git/trees/${current.data.tree.sha}?recursive=1`)
    if (old.status !== 200) throw new HttpError(502, `GitHub: could not list the current files (${old.status})`)
    if (old.data.truncated) throw new HttpError(502, 'The site has too many files to update safely in one go')
    for (const e of old.data.tree as { path: string; mode: string; type: string; sha: string }[]) {
      if (e.type !== 'blob' || e.path in files) continue
      if (keep.has(e.path.split('/')[0])) entries.push({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha })
    }
  }

  // no base_tree: the new tree is exactly `entries`
  const tree = await gh(token, 'POST', `/repos/${repo}/git/trees`, { tree: entries })
  if (tree.status !== 201) throw new HttpError(502, `GitHub: could not build the file tree (${tree.status})`)

  if (tree.data.sha === current.data.tree.sha) return { commit: parent, unchanged: true }

  const commit = await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.data.sha, parents: [parent] })
  if (commit.status !== 201) throw new HttpError(502, `GitHub: could not create the commit (${commit.status})`)

  // not forced: if someone else published since we read the branch, their commit stays and this one is refused
  const ref = await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: false })
  if (ref.status === 422) throw new HttpError(409, 'Someone else published at the same moment — please publish again')
  if (ref.status !== 200) throw new HttpError(502, `GitHub: could not move ${branch} (${ref.status})`)
  return { commit: commit.data.sha as string, unchanged: false }
}

function validate(files: unknown, slug: string): Record<string, string> {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new HttpError(400, 'files must be an object of path → text')
  const entries = Object.entries(files as Record<string, unknown>)
  if (!entries.length) throw new HttpError(400, 'Nothing to publish')
  if (entries.length > MAX_FILES) throw new HttpError(413, `Too many files (max ${MAX_FILES})`)
  const prefix = `${slug}/`
  let bytes = 0
  for (const [path, content] of entries) {
    const ok = ROOT_FILE_RE.test(path) || (path.startsWith(prefix) && VAULT_FILE_RE.test(path.slice(prefix.length)))
    if (!ok) throw new HttpError(400, `Refusing unexpected path: ${path}`)
    if (typeof content !== 'string') throw new HttpError(400, `File ${path} must be text`)
    bytes += content.length
  }
  if (!(`${prefix}index.html` in (files as object))) throw new HttpError(400, 'The vault has no home page')
  if (bytes > MAX_BYTES) throw new HttpError(413, 'Site is too large to publish in one go')
  return files as Record<string, string>
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only')
    const auth = req.headers.get('Authorization')
    if (!auth) throw new HttpError(401, 'Sign in first')

    // a client acting as the caller, so every read below goes through the same RLS the app uses
    const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!key) throw new HttpError(500, 'Function is missing its Supabase key')
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, key, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })

    // the garden is Amogh's GitHub repo: only accounts marked can_publish may write to it
    const { data: allowed, error: allowedErr } = await sb.rpc('nt_can_publish')
    if (allowedErr) throw new HttpError(500, `Permission check failed: ${allowedErr.message}`)
    if (allowed !== true) throw new HttpError(403, 'Publishing isn’t available for your account')

    const token = Deno.env.get('GITHUB_TOKEN')
    const repo = Deno.env.get('GITHUB_REPO')
    const branch = Deno.env.get('GITHUB_BRANCH') || 'main'
    const body = await req.json().catch(() => ({}))

    if (body.action === 'status') {
      return json(200, { configured: !!(token && repo), repo: repo ?? null, branch, siteUrl: repo ? pagesUrl(repo) : null })
    }
    if (!token || !repo) throw new HttpError(412, 'GitHub publishing is not set up yet')
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(500, 'GITHUB_REPO must look like owner/name')

    // the caller's own vault (RLS: nobody can publish someone else's)
    const { data: vaults, error: vaultsErr } = await sb.from('nt_vaults').select('id,name,kind,published_slug')
    if (vaultsErr) throw new HttpError(500, vaultsErr.message)
    const vault = vaults?.find(v => v.id === body.vault_id)
    if (!vault) throw new HttpError(404, 'Vault not found')
    if (vault.kind !== 'public') throw new HttpError(403, 'Only a public vault can be published')

    // every other published vault in the garden, whoever owns it
    const { data: published, error: publishedErr } = await sb.rpc('nt_published_vaults')
    if (publishedErr) throw new HttpError(500, publishedErr.message)
    const slug = slugFor(vault.name)
    const others = ((published ?? []) as { id: string; slug: string; title: string }[]).filter(v => v.id !== vault.id)
    const clash = others.find(v => v.slug === slug)
    if (clash) throw new HttpError(409, `“${clash.title}” is already published at /${slug}/ — give this vault a different name`)
    const keep = new Set(others.map(v => v.slug))

    const files = validate(body.files, slug)
    const notes = Object.keys(files).filter(p => p.startsWith(`${slug}/`) && p.split('/').length === 3).length
    const message = `Publish ${vault.name}: ${notes} ${notes === 1 ? 'page' : 'pages'}`
    const result = await publish(token, repo, branch, files, keep, message)

    if (!result.unchanged || vault.published_slug !== slug) {
      await sb.from('nt_vaults').update({ published_at: new Date().toISOString(), published_commit: result.commit, published_slug: slug }).eq('id', vault.id)
    }
    const site = pagesUrl(repo)
    return json(200, { ...result, repo, slug, siteUrl: site, vaultUrl: `${site}${slug}/`, commitUrl: `https://github.com/${repo}/commit/${result.commit}` })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    console.error('nt-publish', status, (e as Error).message)
    return json(status, { error: (e as Error).message })
  }
})
