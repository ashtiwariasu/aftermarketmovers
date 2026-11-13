/**
 * Intent-matched context for an interactive sitting.
 *
 * The whole checked company file stays eligible. We rank coherent passages
 * against the member's actual question, then admit complete passages rather
 * than clipping an ever-growing folder into the prompt. This is the same
 * separation llmcouncil uses: selection is broad; retrieval is question-shaped.
 */

export interface IntentSource {
  id: string;
  name: string;
  content: string;
}

export interface IntentPassage {
  sourceId: string;
  sourceName: string;
  text: string;
  score: number;
  matchedTerms: string[];
}

export interface IntentSelection {
  label: string;
  queryTerms: string[];
  passages: IntentPassage[];
  matchedSourceIds: string[];
  eligibleSourceCount: number;
  omittedSourceCount: number;
  chars: number;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "because", "before", "being", "between",
  "could", "does", "from", "have", "here", "into", "just", "more", "most", "much", "should",
  "that", "their", "there", "these", "they", "this", "those", "through", "under", "very", "want",
  "what", "when", "where", "which", "while", "with", "would", "your", "tell", "explain", "think",
  "company", "stock", "shares", "please", "latest", "current",
]);

const INTENT_FAMILIES: Array<{
  label: string;
  triggers: RegExp;
  terms: string[];
}> = [
  {
    label: "earnings and financial performance",
    triggers: /\b(?:earnings?|revenue|sales|margin|profit|income|eps|cash|capex|debt|balance sheet|quarter|financials?)\b/i,
    terms: ["earnings", "revenue", "margin", "operating income", "net income", "cash flow", "capex", "debt", "eps", "quarter", "xbrl"],
  },
  {
    label: "guidance and forward expectations",
    triggers: /\b(?:guidance|outlook|forecast|expectations?|targets?|next quarter|next filing|watch next)\b/i,
    terms: ["guidance", "outlook", "expectations", "forecast", "management", "next quarter", "watch next", "invalidation"],
  },
  {
    label: "risk and downside",
    triggers: /\b(?:risk|downside|bear|break|wrong|threat|concern|weakness|dissent|oppose)\b/i,
    terms: ["risk", "downside", "bear", "uncertainty", "dissent", "oppose", "invalidation", "competition", "regulatory"],
  },
  {
    label: "thesis and catalyst",
    triggers: /\b(?:thesis|signal|catalyst|opportunity|bull|support|upside|why it matters|changed|move)\b/i,
    terms: ["thesis", "signal", "catalyst", "opportunity", "bull", "support", "why it matters", "what changed", "mechanism", "evidence"],
  },
  {
    label: "filings and primary evidence",
    triggers: /\b(?:filing|filed|sec|edgar|10-?[qk]|8-?k|annual report|quarterly report|primary source)\b/i,
    terms: ["filing", "filed", "sec", "edgar", "10-q", "10-k", "8-k", "primary source", "official record"],
  },
  {
    label: "news and recent events",
    triggers: /\b(?:news|today|yesterday|overnight|headline|recent|happened|event|announcement)\b/i,
    terms: ["news", "headline", "overnight", "announcement", "event", "published", "recent", "what changed"],
  },
  {
    label: "competition and product",
    triggers: /\b(?:competitor|competition|market share|product|customer|demand|pricing|ai|cloud|advertising|segment)\b/i,
    terms: ["competition", "competitor", "market share", "product", "customer", "demand", "pricing", "segment", "cloud", "advertising"],
  },
  {
    label: "price action and market context",
    triggers: /\b(?:price|market|tape|after hours|session|momentum|selloff|rally|volume|52-week)\b/i,
    terms: ["price", "after hours", "session", "one-month", "selloff", "rally", "market", "sector", "52-week"],
  },
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9%$.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionTerms(question: string): { label: string; terms: string[] } {
  const normalized = normalize(question);
  const direct = normalized
    .split(" ")
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const matchedFamilies = INTENT_FAMILIES.filter((family) => family.triggers.test(question));
  const expanded = matchedFamilies.flatMap((family) => family.terms);
  const fallback = matchedFamilies.length === 0
    ? ["thesis", "evidence", "what changed", "risk", "numbers", "filing", "news"]
    : [];
  return {
    label: matchedFamilies.map((family) => family.label).join(" + ") || "company thesis and evidence",
    terms: [...new Set([...direct, ...expanded, ...fallback].map(normalize).filter(Boolean))],
  };
}

/** Split on authored boundaries. Long prose is divided at sentence boundaries, never mid-word. */
function coherentPassages(content: string, targetChars = 2_400): string[] {
  const blocks = content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}|(?=^#{1,6}\s)/gm)
    .map((part) => part.trim())
    .filter(Boolean);
  const atomic: string[] = [];
  for (const block of blocks) {
    if (block.length <= targetChars * 1.5) {
      atomic.push(block);
      continue;
    }
    const sentences = block.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()).filter(Boolean);
    let group = "";
    for (const sentence of sentences) {
      if (group && group.length + sentence.length + 1 > targetChars) {
        atomic.push(group);
        group = sentence;
      } else {
        group += `${group ? " " : ""}${sentence}`;
      }
    }
    if (group) atomic.push(group);
  }

  const passages: string[] = [];
  let current = "";
  for (const block of atomic) {
    if (current && current.length + block.length + 2 > targetChars) {
      passages.push(current);
      current = block;
    } else {
      current += `${current ? "\n\n" : ""}${block}`;
    }
  }
  if (current) passages.push(current);
  return passages;
}

function occurrences(haystack: string, needle: string): number {
  if (!needle || !haystack.includes(needle)) return 0;
  let count = 0;
  let from = 0;
  while (count < 4) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

function scorePassage(name: string, text: string, terms: string[], question: string): { score: number; matched: string[] } {
  const title = normalize(name);
  const body = normalize(text);
  const matched: string[] = [];
  let score = 0;
  for (const term of terms) {
    const titleHits = occurrences(title, term);
    const bodyHits = occurrences(body, term);
    if (titleHits || bodyHits) matched.push(term);
    score += titleHits * 7 + bodyHits * (term.includes(" ") ? 3 : 1.4);
  }
  const directPhrase = normalize(question)
    .split(" ")
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 6)
    .join(" ");
  if (directPhrase.length >= 8 && body.includes(directPhrase)) score += 12;
  if (/\b(?:sec|edgar|10-q|10-k|8-k|xbrl|filing)\b/.test(title) && matched.length > 0) score += 2;
  if (/\b(?:dossier|thesis|evidence|council|chairman)\b/.test(title) && /thesis|signal|evidence|risk|bull|bear/.test(terms.join(" "))) score += 2;
  return { score, matched: [...new Set(matched)].slice(0, 10) };
}

export function selectIntentEvidence(
  question: string,
  sources: IntentSource[],
  options: { maxChars?: number; maxPassages?: number; maxPerSource?: number } = {}
): IntentSelection {
  const { label, terms } = questionTerms(question);
  const maxChars = Math.max(8_000, options.maxChars ?? 52_000);
  const maxPassages = Math.max(4, options.maxPassages ?? 24);
  const maxPerSource = Math.max(1, options.maxPerSource ?? 3);
  const candidates = sources.flatMap((source, sourceOrder) =>
    coherentPassages(source.content).map((text, passageOrder) => {
      const ranked = scorePassage(source.name, text, terms, question);
      return { source, sourceOrder, passageOrder, text, ...ranked };
    })
  );
  candidates.sort((a, b) =>
    b.score - a.score || a.sourceOrder - b.sourceOrder || a.passageOrder - b.passageOrder
  );

  const best = candidates[0]?.score ?? 0;
  const threshold = best > 0 ? Math.max(1, Math.min(best, Math.max(2.5, best * 0.28))) : 0;
  const selected: IntentPassage[] = [];
  const perSource = new Map<string, number>();
  let chars = 0;
  for (const candidate of candidates) {
    if (best > 0 && candidate.score <= 0) continue;
    if (best > 0 && candidate.score < threshold) continue;
    if (selected.length >= maxPassages) break;
    if ((perSource.get(candidate.source.id) ?? 0) >= maxPerSource) continue;
    const admissionChars = candidate.text.length + candidate.source.name.length + 40;
    if (chars + admissionChars > maxChars) continue;
    selected.push({
      sourceId: candidate.source.id,
      sourceName: candidate.source.name,
      text: candidate.text,
      score: Number(candidate.score.toFixed(2)),
      matchedTerms: candidate.matched,
    });
    chars += admissionChars;
    perSource.set(candidate.source.id, (perSource.get(candidate.source.id) ?? 0) + 1);
  }

  const matchedSourceIds = [...new Set(selected.map((passage) => passage.sourceId))];
  return {
    label,
    queryTerms: terms,
    passages: selected,
    matchedSourceIds,
    eligibleSourceCount: sources.length,
    omittedSourceCount: Math.max(0, sources.length - matchedSourceIds.length),
    chars,
  };
}

export function formatIntentEvidence(selection: IntentSelection): string {
  const grouped = new Map<string, IntentPassage[]>();
  for (const passage of selection.passages) {
    const list = grouped.get(passage.sourceId) ?? [];
    list.push(passage);
    grouped.set(passage.sourceId, list);
  }
  const sections: string[] = [];
  for (const passages of grouped.values()) {
    const first = passages[0];
    sections.push(
      `FILE SOURCE — ${first.sourceName} [document ${first.sourceId}]:\n` +
      passages.map((passage) => passage.text).join("\n\n[… next matched passage from this source …]\n\n")
    );
  }
  return sections.join("\n\n---\n\n");
}
