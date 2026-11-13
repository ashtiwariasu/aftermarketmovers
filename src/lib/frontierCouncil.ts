/**
 * The frontier room — the dossier engine's deliberation chamber.
 *
 * A/B-proven shape (2026-07-14, blind 3-judge, order-swapped: won 6/6 vs the
 * symmetric peer-ranked council at ~2/3 the cost and half the latency):
 * one LEAD ANALYST drafts the full dossier, three specialist auditors on
 * distinct model families verify it — THE NUMBERS SEAT recomputes every
 * figure, THE RISK SEAT builds the strongest counter-case, THE EVIDENCE
 * MARSHAL audits provenance against the bundle. The lifecycle-routed chairman
 * in dossier.ts handles canonical lifecycle decisions and daily continuity.
 *
 * The lead rotates daily between the Anthropic and OpenAI lanes:
 * measured a tie (3-3, identical averages), and rotation seeds per-family
 * lead-performance data for a future per-class assignment table.
 *
 * Every seat walks a family LANE — primary → retry → family backup.
 * A repeated entry is an explicit same-model transport retry. Every default
 * is routed through the central cost-controlled production policy.
 * No output budgets anywhere: a seat thinks and writes until it is done.
 */

import { COUNCIL_MODELS, MODEL_POLICY_VERSION } from "@/lib/modelPolicy";

export const LANES = {
  openai: [COUNCIL_MODELS.openai, COUNCIL_MODELS.openai],
  anthropic: [
    COUNCIL_MODELS.anthropic,
    COUNCIL_MODELS.anthropic,
    COUNCIL_MODELS.anthropicFallback,
  ],
  google: [COUNCIL_MODELS.google, COUNCIL_MODELS.google],
  xai: [COUNCIL_MODELS.xai, COUNCIL_MODELS.xai],
  moonshot: [COUNCIL_MODELS.moonshot, COUNCIL_MODELS.moonshot],
};
export const LANE_TIMEOUTS = [600_000, 300_000, 180_000];

/** Whichever flagship lane leads today (rotates daily); the other marshals. */
export function leadRotation(): { leadLane: string[]; marshalLane: string[] } {
  const anthropicLeads = Math.floor(Date.now() / 86_400_000) % 2 === 0;
  return anthropicLeads
    ? { leadLane: LANES.anthropic, marshalLane: LANES.openai }
    : { leadLane: LANES.openai, marshalLane: LANES.anthropic };
}

export const FRONTIER_PUBLIC_RESEARCH_RULES =
  "No buy/sell/hold language, personalised allocation, price target, fair-value estimate or percentage forecast. " +
  "Any public signal is qualitative only: UP or DOWN, GENTLE/MODERATE/STRONG, over exactly 10-15 trading sessions.";

const LEAD_SYSTEM =
  "You are the LEAD ANALYST on a research desk's council. Write the full dossier draft: business strategy & outlook + the single question this file is working, " +
  "3 bulls, 3 bears (each anchored to a verifiable fact from the bundle), risk & uncertainty, and a read of the filed fundamentals. " +
  "Identify the strongest supported event family (earnings, guidance, regulatory, product, legal, capital, leadership, macro or other), causal mechanism, " +
  "qualitative direction and falsifiable invalidation over the fixed 10-15-session horizon. Ground everything ONLY in the verified source bundle. " +
  `${FRONTIER_PUBLIC_RESEARCH_RULES} Evidence framing only, plain words.`;

export const AUDITORS: Array<{ lane: keyof typeof LANES | "flagship"; role: string; brief: string; shadow?: boolean }> = [
  {
    lane: "google",
    role: "THE NUMBERS SEAT",
    brief:
      "Verify every figure, growth rate, and date in the draft against the source bundle. Recompute what can be recomputed. " +
      "List: VERIFIED figures, MISMATCHES (draft vs bundle), and any AMBIGUITY in the filed data itself. Test whether the proposed 10-15-session mechanism follows from those figures. Be exact.",
  },
  {
    lane: "xai",
    role: "THE RISK SEAT",
    brief:
      "Make the strongest evidence-anchored case AGAINST the draft's central read, using only the bundle. " +
      "What is the draft underweighting or missing? What observable evidence would negate its qualitative direction within 10-15 sessions?",
  },
  {
    lane: "moonshot",
    role: "THE GLOBAL CONTEXT SEAT (SHADOW ADVISORY)",
    shadow: true,
    brief:
      "Advisory seat — you hold no vote; you inform the chairman. Audit the draft for what a US-centric desk misses: supply-chain exposure (fabs, assembly, rare inputs), " +
      "non-US regulation and policy, currency/macro spillover, and regional demand signals. Using ONLY the bundle, list: MISSED GLOBAL FACTORS the draft ignores, " +
      "OVERSTATED ones it leans on, and any bundle fact whose global context changes its weight. Trial seat under evaluation — be concrete or be silent.",
  },
  {
    lane: "flagship", // resolved at runtime to whichever flagship lane is not leading
    role: "THE EVIDENCE MARSHAL",
    brief:
      "Audit provenance. List every factual claim in the draft that CANNOT be traced to the source bundle (quote the claim). " +
      "List any bundle fact the draft ignored that a member would want. Reject any recommendation, target, fair value or percentage forecast. The bundle is the ONLY admissible source.",
  },
];

/** Shadow advice is optional; every core auditor must answer or this council is unusable. */
export const REQUIRED_AUDITOR_ROLES = AUDITORS
  .filter((auditor) => !auditor.shadow)
  .map((auditor) => auditor.role);

export function hasRequiredFrontierAuditCoverage(
  audits: ReadonlyArray<{ role: string }>,
): boolean {
  const completed = new Set(audits.map((audit) => audit.role));
  return REQUIRED_AUDITOR_ROLES.every((role) => completed.has(role));
}

/** Included in dossier checkpoint keys so a lane or validator change invalidates stale work. */
export const FRONTIER_CONTRACT_POLICY = JSON.stringify({
  version: "frontier-council-v5-cost-controlled",
  modelPolicyVersion: MODEL_POLICY_VERSION,
  lanes: LANES,
  laneTimeouts: LANE_TIMEOUTS,
  leadRotation: "utc-day-anthropic-openai",
  auditors: AUDITORS,
  publicRules: FRONTIER_PUBLIC_RESEARCH_RULES,
});

/** Deterministic formatting lets checkpoints store seats once, not duplicate a huge chair input. */
export function buildFrontierChairUser(
  question: string,
  seats: Array<{ role: string; model: string; response: string }>,
): string {
  const lead = seats.find((seat) => seat.role === "LEAD ANALYST") ?? seats[0];
  if (!lead) return "";
  const audits = seats.filter((seat) => seat !== lead);
  const auditBlock = audits.length > 0
    ? audits.map((seat) => `${seat.role} (${seat.model}) AUDIT:\n${seat.response}`).join("\n\n---\n\n")
    : "(no audits returned this run — treat the draft with extra caution and keep only bundle-traceable claims)";
  return `Question put to the council: ${question}\n\n=== LEAD DRAFT ===\n${lead.response}\n\n` +
    `=== SPECIALIST AUDITS (correct the draft where they found problems; drop or flag any claim ` +
    `the Evidence Marshal could not trace to the bundle; fold the Risk seat's case into bears/risk) ===\n\n${auditBlock}`;
}

export interface FrontierCouncilResult {
  stage1: Array<{
    model: string;
    role: string;
    response: string;
    error?: string | null;
    usage?: CouncilModelUsage;
  }>;
  /** Pre-formatted chairman input: lead draft + specialist audits + merge directives. */
  chairUser: string;
  aggregate: Array<{ model: string; average_rank: number; rankings_count: number }>;
  consensus?: number;
  winner: string;
  models: string[];
}

export interface CouncilModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

interface ModelCallResult {
  text: string;
  usage?: CouncilModelUsage;
}

async function orCall(
  model: string,
  messages: Array<{ role: string; content: string }>,
  reasoning?: { effort: string }
): Promise<ModelCallResult | null> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  // No max_tokens — no output budget (Ash rule): a seat thinks and writes
  // until it is done. OpenRouter fills each provider's own maximum.
  const body: Record<string, unknown> = { model, messages, usage: { include: true } };
  if (reasoning) body.reasoning = reasoning;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": "AMM Frontier Council",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[council] ${model} HTTP ${res.status}${reasoning ? " (retrying without reasoning)" : ""}`);
      // Some providers reject the unified reasoning param — retry once without it.
      if (reasoning) return orCall(model, messages);
      return null;
    }
    const json = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      console.error(`[council] ${model} empty content (finish=${json?.choices?.[0]?.finish_reason})`);
      return null;
    }
    const rawUsage = json?.usage;
    const usage = rawUsage
      ? {
          ...(Number.isFinite(rawUsage.prompt_tokens) ? { inputTokens: Number(rawUsage.prompt_tokens) } : {}),
          ...(Number.isFinite(rawUsage.completion_tokens) ? { outputTokens: Number(rawUsage.completion_tokens) } : {}),
          ...(Number.isFinite(rawUsage.total_tokens) ? { totalTokens: Number(rawUsage.total_tokens) } : {}),
          ...(Number.isFinite(rawUsage.cost) ? { costUsd: Number(rawUsage.cost) } : {}),
        }
      : undefined;
    return { text, ...(usage && Object.keys(usage).length > 0 ? { usage } : {}) };
  } catch (e) {
    console.error(`[council] ${model} ${String(e).slice(0, 120)}`);
    return null;
  }
}

/**
 * Streaming variant of orCall: forwards content tokens to onDelta as they
 * arrive. Same no-budget, retry-without-reasoning semantics.
 */
export async function streamCall(
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
  onDelta: (text: string) => void,
  reasoning?: { effort: string },
  requestTitle = "AMM Frontier Council"
): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (reasoning) body.reasoning = reasoning;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aftermarketmovers.com",
        "X-Title": requestTitle,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
      console.error(`[council] ${model} HTTP ${res.status}${reasoning ? " (retrying without reasoning)" : ""}`);
      if (reasoning) return streamCall(model, messages, timeoutMs, onDelta, undefined, requestTitle);
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta: string = json?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* keep-alive comment or partial frame */
        }
      }
    }
    if (!full.trim()) {
      console.error(`[council] ${model} empty stream`);
      return null;
    }
    return full;
  } catch (e) {
    console.error(`[council] ${model} ${String(e).slice(0, 120)}`);
    return null;
  }
}

/** Walk a family lane with streaming: primary → retry → family backup. */
export async function runLaneStream(
  lane: string[],
  system: string,
  user: string,
  onDelta: (text: string) => void
): Promise<{ model: string; text: string } | null> {
  for (let attempt = 0; attempt < lane.length; attempt++) {
    const model = lane[attempt];
    const text = await streamCall(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      LANE_TIMEOUTS[attempt] ?? 120_000,
      onDelta,
      { effort: "high" }
    );
    if (text) return { model, text };
    console.error(`[council] lane ${lane[0]} attempt ${attempt + 1} (${model}) failed`);
  }
  return null;
}

/** Walk a family lane: primary → retry → family backup. */
async function runLane(
  lane: string[],
  system: string,
  user: string
): Promise<{ model: string; text: string; usage?: CouncilModelUsage } | null> {
  for (let attempt = 0; attempt < lane.length; attempt++) {
    const model = lane[attempt];
    const result = await orCall(
      model,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { effort: "high" }
    );
    if (result) return { model, text: result.text, ...(result.usage ? { usage: result.usage } : {}) };
    console.error(`[council] lane ${lane[0]} attempt ${attempt + 1} (${model}) failed`);
  }
  return null;
}

export async function runFrontierCouncil(
  question: string,
  context: string
): Promise<FrontierCouncilResult | null> {
  // Lead rotates daily between the two flagship lanes (measured tie; rotation
  // seeds per-family lead-performance data). The other flagship marshals.
  const { leadLane, marshalLane } = leadRotation();

  const lead = await runLane(leadLane, LEAD_SYSTEM, `${question}\n\nVERIFIED SOURCE BUNDLE:\n${context}`);
  if (!lead) return null; // dossier.ts falls back to the llmc3 council
  // The daily dossier is the canonical research artifact. Preserve the lead's
  // complete draft for the auditors, chairman, and immutable run record.
  const draft = lead.text;

  const audits = (
    await Promise.all(
      AUDITORS.map(async (a) => {
        const lane = a.lane === "flagship" ? marshalLane : LANES[a.lane];
        const r = await runLane(
          lane,
          `You are ${a.role} on a research desk's council. ${a.brief} ${FRONTIER_PUBLIC_RESEARCH_RULES}`,
          `SOURCE BUNDLE:\n${context}\n\n=== LEAD DRAFT UNDER REVIEW ===\n${draft}`
        );
        return r
          ? { role: a.role, model: r.model, text: r.text, ...(r.usage ? { usage: r.usage } : {}) }
          : null;
      })
    )
  ).filter((x): x is { role: string; model: string; text: string; usage?: CouncilModelUsage } => x !== null);

  if (!hasRequiredFrontierAuditCoverage(audits)) {
    const completed = new Set(audits.map((audit) => audit.role));
    const missing = REQUIRED_AUDITOR_ROLES.filter((role) => !completed.has(role));
    console.error(`[council] required auditors unavailable: ${missing.join(", ")}`);
    return null; // dossier.ts falls back to the independent llmc3 council
  }

  const chairUser = buildFrontierChairUser(question, [
    { role: "LEAD ANALYST", model: lead.model, response: lead.text },
    ...audits.map((audit) => ({ role: audit.role, model: audit.model, response: audit.text })),
  ]);

  return {
    stage1: [
      {
        model: lead.model,
        role: "LEAD ANALYST",
        response: lead.text,
        ...(lead.usage ? { usage: lead.usage } : {}),
      },
      ...audits.map((a) => ({
        model: a.model,
        role: a.role,
        response: a.text,
        ...(a.usage ? { usage: a.usage } : {}),
      })),
    ],
    chairUser,
    aggregate: [],
    consensus: undefined,
    winner: lead.model,
    models: [lead.model, ...audits.map((a) => a.model)],
  };
}
