export type PageKind = 'note' | 'daily' | 'canvas'

export interface Page {
  id: string
  title: string
  kind: PageKind
  body: string
  created_at: string
  updated_at: string
  /** Local only: created with "+" but not yet written to the database (dropped if left empty). */
  draft?: boolean
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
