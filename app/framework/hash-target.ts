/**
 * The deep-link target for a URL hash.
 *
 * The framework page renders its sections only after an async content fetch, so
 * the browser's own fragment handling at load finds nothing to scroll to — the
 * target does not exist yet. The viewer scrolls again once the content is ready.
 *
 * Working out which element a hash names is the one part of that logic that can
 * be wrong in a way a reader would notice, so it lives here on its own and is
 * tested directly, without a DOM.
 */

/**
 * The element id a URL hash points at, or null when the hash names nothing.
 *
 * Returns null for an empty hash and for "#" alone. A hash whose id does not
 * decode (a malformed percent escape) is not a usable id, so the raw text after
 * the "#" is returned rather than letting the decode throw.
 */
export function hashTargetId(hash: string): string | null {
  if (!hash || hash === "#") return null;
  const raw = hash.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
