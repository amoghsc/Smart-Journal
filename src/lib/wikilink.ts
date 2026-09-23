import { Extension, InputRule, Node, mergeAttributes } from '@tiptap/core'

export interface WikilinkOptions {
  /** Maps typed text to the canonical title of an existing page (case-insensitive), or returns it unchanged. */
  resolve: (title: string) => string
  /** Called whenever a link is made, so the target page can be created. */
  onCreate: (title: string) => void
  /** Opens a date picker next to `anchor` (viewport px); resolves to YYYY-MM-DD or null if dismissed. */
  pickDate: (anchor?: { x: number; y: number }) => Promise<string | null>
}
interface Pending { from: number; to: number; t: number }

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikilink: { setWikilink: (title: string) => ReturnType }
  }
}

/**
 * Inline atom `<a class="wikilink" data-title="…">` pointing at another page.
 * Made by: selecting text and pressing `[` twice, or typing `[[Title]]`.
 */
export const Wikilink = Node.create<WikilinkOptions, { pending: Pending | null }>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() { return { resolve: t => t, onCreate: () => {}, pickDate: async () => null } },
  addStorage() { return { pending: null } },

  addAttributes() {
    return { title: { default: '', parseHTML: el => el.getAttribute('data-title'), renderHTML: a => ({ 'data-title': a.title }) } }
  },
  parseHTML() { return [{ tag: 'a[data-title]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes({ class: 'wikilink' }, HTMLAttributes), node.attrs.title]
  },

  addCommands() {
    return {
      setWikilink: typed => ({ chain, state }) => {
        const { from, to } = state.selection
        const title = this.options.resolve(typed)
        this.options.onCreate(title)
        return chain().insertContentAt({ from, to }, { type: this.name, attrs: { title } }).run()
      },
    }
  },

  addKeyboardShortcuts() {
    return {
      '[': () => {
        const { from, to, empty, $from, $to } = this.editor.state.selection
        if (empty) return false
        // only a run of text inside one paragraph/list item can become a link
        if (!$from.sameParent($to) || !$from.parent.isTextblock) { this.storage.pending = null; return false }
        const p = this.storage.pending, now = Date.now()
        this.storage.pending = null
        if (p && p.from === from && p.to === to && now - p.t < 2500) {
          const title = this.editor.state.doc.textBetween(from, to, ' ').trim()
          return title ? this.editor.commands.setWikilink(title) : false
        }
        // first `[` with a selection: keep the selection, wait for the second one
        this.storage.pending = { from, to, t: now }
        return true
      },
    }
  },

  addInputRules() {
    return [
    // "/date" → calendar → link to that day's note
    new InputRule({
      find: /\/date$/,
      handler: ({ range, chain }) => {
        const c = this.editor.view.coordsAtPos(range.from)
        chain().deleteRange(range).run()
        this.options.pickDate({ x: c.left, y: c.bottom }).then(d => {
          if (!d) return
          this.options.onCreate(d)
          this.editor.chain().focus().insertContent([{ type: this.name, attrs: { title: d } }, { type: 'text', text: ' ' }]).run()
        })
      },
    }),
    new InputRule({
      find: /\[\[([^[\]]+)\]\]$/,
      handler: ({ range, match, chain }) => {
        const typed = match[1].trim()
        if (!typed) return
        const title = this.options.resolve(typed)
        this.options.onCreate(title)
        chain().insertContentAt(range, { type: this.name, attrs: { title } }).run()
      },
    })]
  },
})

/** Tab on a plain paragraph starts a bullet. Runs before the list extensions. */
export const EditorKeys = Extension.create({
  name: 'editorKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.isActive('listItem') ? false : this.editor.commands.toggleBulletList()),
    }
  },
})

/** Last resort so Tab never leaves the editor (e.g. Tab on the first list item, which cannot sink). */
export const SwallowTab = Extension.create({
  name: 'swallowTab',
  priority: 1,
  addKeyboardShortcuts() { return { Tab: () => true, 'Shift-Tab': () => true } },
})
