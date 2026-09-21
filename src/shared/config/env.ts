/**
 * The only place in `src/` that reads `import.meta.env`. The rest of the code
 * imports ready values from here — so `eval/` and `scripts/` (which run outside
 * Vite) don't trip over `import.meta.env` in shared modules.
 *
 * Neither value below is secret: Vite inlines `VITE_*` into the bundle, so they're
 * visible in production sources. Moving them into environment variables isn't about
 * secrecy — it keeps personal identifiers out of the public repo, so a fork doesn't
 * send mail to someone else's inbox or pollute someone else's analytics. See ADR 0011.
 */

/** Web3Forms feedback form key. Empty — the form honestly reports “didn't get through”. */
export const WEB3FORMS_KEY = import.meta.env.VITE_WEB3FORMS_KEY

/** Google Analytics measurement ID. Empty — the tracker is not loaded. */
export const GA_ID = import.meta.env.VITE_GA_ID
