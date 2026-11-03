/**
 * Browser vendor bundle: the ball's TeX typesetter, a port of ui-primitives
 * src/markdown/katex.ts — the same three-arm error chain (strict render,
 * `strict: 'ignore'` retry, error span with KaTeX's stock `errorColor`) as the
 * main window's chat, so one formula settles the same way in both. Follows the
 * vendored shiki bundle: loaded lazily by assets/math.js from assets/vendor/.
 * Built to assets/vendor/katex.js by `pnpm --filter @dsh-agi/helper
 * build:vendor`; katex.min.css and its woff2 faces are copied beside it by
 * scripts/vendor-katex-assets.mjs.
 */

import katex from 'katex'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch)
}

/**
 * KaTeX HTML for one TeX source, never throwing: a source that does not parse
 * falls back to KaTeX's error span, exactly like the replaced arm upstream.
 *
 * @param tex - The TeX source (display math keeps its text as-is).
 * @param displayMode - Display (block) versus inline rendering.
 * @returns KaTeX's HTML string, ready for a template's innerHTML.
 */
export function renderTexToHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true })
  } catch (error) {
    try {
      return katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      return `<span class="katex-error" style="color:#cc0000" title="${escapeHtml(String(error))}">${escapeHtml(tex)}</span>`
    }
  }
}
