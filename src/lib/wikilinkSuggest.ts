import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

export interface SuggestItem {
  title: string
  /** Offered when no existing note matches: link to a new note with this title. */
  create?: boolean
}

export type WikilinkSuggestOptions = Pick<SuggestionOptions<SuggestItem>, 'items' | 'render' | 'command'>

/**
 * Typing `[[` opens a list of existing notes; typing further filters it.
 * Picking one replaces `[[query` with a wikilink. Rendering is left to the caller.
 */
export const WikilinkSuggest = Extension.create<WikilinkSuggestOptions>({
  name: 'wikilinkSuggest',

  addOptions() {
    return { items: () => [], render: () => ({}), command: () => {} }
  },

  addProseMirrorPlugins() {
    return [Suggestion<SuggestItem>({
      editor: this.editor,
      pluginKey: new PluginKey('wikilinkSuggest'),
      char: '[[',
      allowSpaces: true,          // note titles have spaces
      allowedPrefixes: null,      // works right after a word or bracket too
      items: this.options.items,
      render: this.options.render,
      command: this.options.command,
    })]
  },
})

/** Existing titles matching `query`: starts-with first, then contains, keeping the given (recency) order. */
export function matchTitles(titles: string[], query: string, limit = 8): SuggestItem[] {
  const q = query.trim().toLowerCase()
  const out: SuggestItem[] = []
  if (!q) out.push(...titles.slice(0, limit).map(title => ({ title })))
  else {
    const starts = titles.filter(t => t.toLowerCase().startsWith(q))
    const contains = titles.filter(t => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q))
    out.push(...[...starts, ...contains].slice(0, limit).map(title => ({ title })))
    if (!titles.some(t => t.toLowerCase() === q)) out.push({ title: query.trim(), create: true })
  }
  return out
}
