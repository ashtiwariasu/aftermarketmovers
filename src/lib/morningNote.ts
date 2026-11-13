/** Shared output contract and citation renderer for the single Morning Note
 * implementation in `doorbell.ts`. The retired parallel composer deliberately
 * does not live here: one format, one compliance path, one sender. */

const BLUE = "#2B4BF2";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render only the direct citation-link subset admitted by a v5 dossier. */
export function citedTextHtml(value: string): string {
  const pattern = /\[(\d+ · \d{4}-\d{2}-\d{2})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    const between = value.slice(cursor, index);
    // Models commonly place two source markers beside each other. Preserve a
    // real text-space between adjacent links so Gmail copy/paste and screen
    // readers do not collapse them into one unreadable citation.
    if (!between && html.endsWith("</a>")) html += " ";
    html += escapeHtml(between);
    try {
      const parsed = new URL(match[2]);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
      html += `<a href="${escapeHtml(parsed.toString())}" target="_blank" rel="noopener noreferrer" style="color:${BLUE};font-family:monospace;font-size:11px;font-weight:700;text-decoration:underline">${escapeHtml(match[1])}</a>`;
    } catch {
      html += escapeHtml(match[0]);
    }
    cursor = index + match[0].length;
  }
  return html + escapeHtml(value.slice(cursor));
}

export interface ComposedNote {
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}
