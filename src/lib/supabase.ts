import { createClient } from '@supabase/supabase-js'

// Links in auth emails (password reset, sign-up confirmation) land here with details in the address, which the
// client reads and then removes. Note what they said first: a reset link must end on "set a new password".
const linkParams = new URLSearchParams(location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''))
/** Opened from a password-reset email. */
export const openedFromReset = linkParams.get('type') === 'recovery'
/** Why an email link didn't work (e.g. it expired), if it didn't. */
export const linkError = linkParams.get('error_description')?.replace(/\+/g, ' ') ?? null
// a failed link: tidy the address so a reload doesn't show the error again (a working link's sign-in details are
// read and removed by the client itself — they must stay until then)
if (linkError) history.replaceState(null, '', location.pathname)

/** Where auth emails should send people back to: this app's own address (the project is shared with other apps). */
export const appUrl = () => location.origin + location.pathname

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
)
