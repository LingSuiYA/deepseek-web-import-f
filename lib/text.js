/**
 * Markdown normalization for imported DeepSeek text.
 *
 * DeepSeek's web UI renders two things that a plain Markdown viewer does not:
 *
 * - `[reference:N]` — citation chips whose targets live only in the live search
 *   state, never in `history_messages`. Without the targets they are noise, and
 *   are removed.
 * - `<br>` — raw HTML line breaks, mostly inside table cells. A viewer that does
 *   not allow raw HTML shows the tag itself, so it becomes a space (a newline
 *   would break the table row).
 *
 * Fenced code blocks are left untouched: a `<br>` or a literal `[reference:1]`
 * inside code is content, not a rendering artifact.
 *
 * @module deepseek-web-import/text
 */

const REFERENCE_MARKER = /\[reference:\d+\]/gi
const BREAK_TAG = /<br\s*\/?>/gi
const FENCE = /^\s*(?:```|~~~)/

/**
 * Remove rendering-only artifacts DeepSeek's own viewer understands.
 * @param {string} text - fragment text from the API.
 * @returns {string} the text with citation markers and stray break tags removed.
 */
export function cleanDeepSeekMarkdown(text) {
  const value = String(text === undefined || text === null ? '' : text)
  if (!value.includes('[reference:') && !/<br/i.test(value)) return value
  let inFence = false
  return value.split('\n').map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.replace(REFERENCE_MARKER, '').replace(BREAK_TAG, ' ')
  }).join('\n')
}
