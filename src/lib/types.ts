export type PageKind = 'note' | 'daily' | 'canvas'
export type VaultKind = 'private' | 'public'

/** A vault is a separate namespace of notes. Only a public vault can be published. */
export interface Vault {
  id: string
  name: string
  kind: VaultKind
  site_title: string | null
  site_description: string | null
  site_author: string | null
  site_url: string | null
  published_at?: string | null
  published_commit?: string | null
  /** Folder this vault is published under on the site (set by the publisher). */
  published_slug?: string | null
  sort_order: number
  created_at: string
}

export interface Page {
  id: string
  vault_id: string
  title: string
  kind: PageKind
  body: string
  created_at: string
  updated_at: string
  /** Held back when its vault is published. */
  draft?: boolean
  /** Seconds spent with this note open and in use (see lib/activeTime). */
  active_seconds?: number
  /** Words typed in this note by hand (not pasted, not AI-written). */
  typed_words?: number
  /** Local only: created with "+" but not yet written to the database (dropped if left empty). */
  local?: boolean
}

/** A card on a canvas: either a reference to a page or a free-text sticky. */
export interface CanvasItem {
  id: string
  canvas_id: string
  page_id: string | null
  text: string | null
  x: number
  y: number
  w: number
  h: number
  color: string | null
}

export type ViewMode = 'editor' | 'split' | 'canvas'

/** An AI tool someone made for themselves (✨ menu, "My tools"). */
export interface AiTool {
  id: string
  name: string
  /** When it's offered: on a single word, within one sentence/line, or on any selection. */
  scope: 'word' | 'sentence' | 'any'
  /** What happens with the result. */
  output: 'replace' | 'after' | 'choose' | 'comment'
  /** The instructions Gemini follows. */
  prompt: string
  creativity: 'precise' | 'balanced' | 'creative'
  /** One result even when two versions to compare is on. */
  single: boolean
  sort_order: number
  /** Who made it (a tool shared with everyone belongs to its maker). */
  owner?: string
  /** private: only its maker has it · submitted: waiting for the admin to approve · published: everyone has it */
  status?: 'private' | 'submitted' | 'published'
  /** The maker's name, once they've asked to share it. */
  author_name?: string | null
}

/** Something the app tells one person (a tool to review, a tool approved). */
export interface AppNotice {
  id: string
  kind: 'tool-submitted' | 'tool-published' | string
  title: string
  body: string | null
  tool_id: string | null
  created_at: string
  read_at: string | null
}
