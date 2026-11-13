export interface VoiceCitation {
  label: string;
  href?: string;
}

const markdownLink = /\[([^\]\n]{1,180})\]\((https?:\/\/[^)\s]+)\)/g;
const plainUrl = /(?<!\]\()https?:\/\/[^\s)<]+/g;
const sourceMarker = /\[(S\d+|document [^\]\n]{1,80})\]/gi;

export function citationsFromAnswer(answer: string): VoiceCitation[] {
  const citations: VoiceCitation[] = [];
  for (const match of answer.matchAll(markdownLink)) {
    citations.push({ label: match[1].trim(), href: match[2] });
  }
  for (const match of answer.matchAll(plainUrl)) {
    citations.push({ label: new URL(match[0]).hostname.replace(/^www\./, ""), href: match[0] });
  }
  for (const match of answer.matchAll(sourceMarker)) citations.push({ label: match[1] });
  return citations.filter((citation, index, all) =>
    all.findIndex((other) => other.label === citation.label && other.href === citation.href) === index
  );
}

/**
 * Convert the already source-gated written answer into speech without asking a
 * second model to reinterpret it. Dates and source names remain audible; URLs,
 * markdown furniture and long reference identifiers do not.
 */
export function spokenAnswerFromMarkdown(answer: string): string {
  return answer
    .replace(markdownLink, "$1")
    .replace(plainUrl, "")
    .replace(sourceMarker, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5_500);
}

