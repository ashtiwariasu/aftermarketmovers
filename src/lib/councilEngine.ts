// The LLM Council machinery, NightDesk edition.
// Same protocol as llmcouncil.ai: independent seat answers in parallel →
// anonymized cross-evaluation → chairman synthesis with visible dissent.
// Models ride the same OpenRouter gateway (shared OPENROUTER_API_KEY secret).

import {
  AUXILIARY_MODELS,
  COUNCIL_MODELS,
  LLMC3_COUNCIL_TIER,
  RESEARCH_MODELS,
} from "@/lib/modelPolicy";

export interface SeatResult {
  seat: string;
  stance: "align" | "caution" | "against";
  line: string;
}

export interface CouncilResult {
  question: string;
  vote: string; // e.g. "3–2"
  seats: SeatResult[];
  synthesis: string;
  dissent: string;
  ranAt: number;
  /** Which machinery produced this: "llmc3" (the real council) or "local". */
  engine?: "llmc3" | "local";
  /** Peer-review consensus from the llmc3 two-stage pipeline (0–1). */
  consensus?: number;
  /** Stage-1 winner model per anonymous peer rankings. */
  winner?: string;
}

// ---- llmc3 bridge: the fully functional council over the internal API ----

interface Llmc3Stage1 {
  model: string;
  response: string;
  error?: string | null;
}

interface Llmc3Result {
  stage1: Llmc3Stage1[];
  aggregate: Array<{ model: string; average_rank: number; rankings_count: number }>;
  consensus: number;
  winner: string;
  models: string[];
}

function shortModel(id: string): string {
  return id.includes("/") ? id.split("/")[1] : id;
}

export async function callLlmc3Council(
  question: string,
  context: string,
  timeoutMs = 110_000
): Promise<Llmc3Result | null> {
  const base = process.env.LLMC3_COUNCIL_URL;
  const token = process.env.INTERNAL_COUNCIL_TOKEN;
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/internal/council`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": token,
      },
      body: JSON.stringify({
        question,
        context,
        max_models: 5,
        // The bridge defaults to standard today, but make the cost ceiling an
        // explicit part of AMM's request contract so a remote default cannot
        // silently move emergency dossier work onto premium seats.
        tier: LLMC3_COUNCIL_TIER,
      }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Llmc3Result;
    const answers = (json.stage1 ?? []).filter((s) => s.response && !s.error);
    if (answers.length < 2) return null;
    return json;
  } catch {
    return null;
  }
}

/** Chairman pass over the REAL llmc3 council output → NightDesk card JSON. */
export async function chairLlmc3Result(
  question: string,
  context: string,
  raw: Llmc3Result
): Promise<CouncilResult | null> {
  const answers = raw.stage1.filter((s) => s.response && !s.error);
  const ranks = new Map(raw.aggregate?.map((a) => [a.model, a.average_rank]));
  const body = answers
    .map(
      (a) =>
        `${shortModel(a.model)} (peer avg rank ${ranks.get(a.model)?.toFixed(2) ?? "?"}):\n${a.response}`
    )
    .join("\n\n---\n\n");

  const chairSystem = `${GUARDRAIL}\nYou chair the LLM Council. Below are independent analyst answers (each a different frontier model) with their anonymous peer-review average ranks (lower = ranked better by peers). Respond with ONLY valid JSON, no markdown fences:
{
 "seats": [{"seat": "<model short name>", "stance": "align|caution|against", "line": "<their position in one sentence, <=22 words>"}],
 "vote": "<X–Y, X = models broadly aligned with the majority reading>",
 "synthesis": "<the chairman's answer to the member, <=130 words, plain English, no advice>",
 "dissent": "<the single strongest opposing point, <=35 words>"
}`;
  const chairUser = `Member question: ${question}\n\nContext:\n${context}\n\nPeer-review consensus: ${(raw.consensus * 100).toFixed(0)}% · Stage-1 winner by peers: ${shortModel(raw.winner)}\n\nCouncil answers:\n\n${body}`;

  const chairRaw =
    (await callModel(CHAIRMAN_MODEL, chairSystem, chairUser, 900)) ??
    (await callModel(COUNCIL_MODELS.anthropicFallback, chairSystem, chairUser, 900));
  if (!chairRaw) return null;
  const parsed = extractJson(chairRaw);
  if (!parsed || !Array.isArray(parsed.seats)) return null;

  const seats: SeatResult[] = (parsed.seats as SeatResult[])
    .filter((s) => s && s.seat && s.line)
    .slice(0, 6)
    .map((s) => ({
      seat: shortModel(String(s.seat)),
      stance: (["align", "caution", "against"].includes(s.stance)
        ? s.stance
        : "caution") as SeatResult["stance"],
      line: String(s.line).slice(0, 220),
    }));

  return {
    question,
    vote:
      typeof parsed.vote === "string" ? parsed.vote.slice(0, 8) : `${seats.length}–0`,
    seats,
    synthesis:
      typeof parsed.synthesis === "string"
        ? parsed.synthesis.slice(0, 1200)
        : "The AI analysts reviewed the question; see their positions.",
    dissent:
      typeof parsed.dissent === "string" ? parsed.dissent.slice(0, 300) : "",
    ranAt: Date.now(),
    engine: "llmc3",
    consensus: raw.consensus,
    winner: shortModel(raw.winner),
  };
}

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

// Provider-diverse roster from the llmc3 model registry.
const SEATS: Array<{ seat: string; model: string; mandate: string }> = [
  {
    seat: "Business",
    model: COUNCIL_MODELS.anthropic,
    mandate:
      "business model, durability, unit economics — is the underlying story real?",
  },
  {
    seat: "Numbers",
    model: COUNCIL_MODELS.deepseek,
    mandate:
      "the financials — cash conversion, margins, dilution, balance sheet. Does the math hold?",
  },
  {
    seat: "Industry",
    model: AUXILIARY_MODELS.legacyIndustrySeat,
    mandate:
      "competitors and sector currents — is this company-specific or just the tide?",
  },
  {
    seat: "Expectations",
    model: COUNCIL_MODELS.google,
    mandate:
      "what the market already prices in, and what would actually surprise it.",
  },
  {
    seat: "Skeptic",
    model: COUNCIL_MODELS.anthropicFallback,
    mandate:
      "disagree if at all defensible. Hunt for what breaks the optimistic reading.",
  },
];

const FALLBACK_MODEL = COUNCIL_MODELS.deepseek;
const CHAIRMAN_MODEL = RESEARCH_MODELS.dailyChair;

const GUARDRAIL =
  "You are a research analyst, not an adviser. Never give buy/sell/hold advice, price targets, or personal recommendations. Discuss evidence, risks, and what to watch. Plain English, retail-readable.";

async function callModel(
  model: string,
  system: string,
  user: string,
  maxTokens: number
): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(OR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": "AMM Desk",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function runCouncil(
  question: string,
  context: string
): Promise<CouncilResult | null> {
  // Stage 1 — independent seat answers, in parallel, with per-seat fallback.
  const answers = await Promise.all(
    SEATS.map(async ({ seat, model, mandate }) => {
      const system = `${GUARDRAIL}\nYou hold the ${seat} seat on a five-analyst research council. Your mandate: ${mandate}\nAnswer in at most 120 words. Take a clear position.`;
      const user = `Context:\n${context}\n\nQuestion from the member: ${question}`;
      const first = await callModel(model, system, user, 400);
      const answer =
        first ?? (await callModel(FALLBACK_MODEL, system, user, 400));
      return { seat, answer };
    })
  );

  const usable = answers.filter((a) => a.answer);
  if (usable.length < 3) return null;

  // Stage 2 — anonymized cross-evaluation + chairman synthesis.
  const anonymized = usable
    .map((a, i) => `Analyst ${String.fromCharCode(65 + i)} (${a.seat} seat):\n${a.answer}`)
    .join("\n\n---\n\n");

  const chairSystem = `${GUARDRAIL}\nYou chair a research council. You are given the anonymized positions of the seats. Evaluate them against each other, then respond with ONLY valid JSON, no markdown fences:
{
 "seats": [{"seat": "<seat name>", "stance": "align|caution|against", "line": "<their position distilled to one sentence, <=22 words>"}],
 "vote": "<X–Y where X = seats broadly aligned with the majority reading, Y = the rest>",
 "synthesis": "<the chairman's answer to the member, <=120 words, plain English, no advice>",
 "dissent": "<the single strongest opposing point, <=35 words>"
}`;
  const chairUser = `Member question: ${question}\n\nContext:\n${context}\n\nSeat positions:\n\n${anonymized}`;

  const chairRaw =
    (await callModel(CHAIRMAN_MODEL, chairSystem, chairUser, 900)) ??
    (await callModel(COUNCIL_MODELS.anthropicFallback, chairSystem, chairUser, 900));
  if (!chairRaw) return null;

  const parsed = extractJson(chairRaw);
  if (!parsed || !Array.isArray(parsed.seats)) return null;

  const seats: SeatResult[] = (parsed.seats as SeatResult[])
    .filter((s) => s && s.seat && s.line)
    .slice(0, 5)
    .map((s) => ({
      seat: String(s.seat),
      stance: (["align", "caution", "against"].includes(s.stance)
        ? s.stance
        : "caution") as SeatResult["stance"],
      line: String(s.line).slice(0, 220),
    }));

  return {
    question,
    vote: typeof parsed.vote === "string" ? parsed.vote.slice(0, 8) : `${seats.length}–0`,
    seats,
    synthesis:
      typeof parsed.synthesis === "string"
        ? parsed.synthesis.slice(0, 1200)
        : "The AI analysts reviewed the question; see their positions.",
    dissent: typeof parsed.dissent === "string" ? parsed.dissent.slice(0, 300) : "",
    ranAt: Date.now(),
    engine: "local",
  };
}
