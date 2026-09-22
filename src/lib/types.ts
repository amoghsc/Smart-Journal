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
