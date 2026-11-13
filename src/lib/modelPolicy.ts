/**
 * Production model routing for AMM's research workloads.
 *
 * The council shape, provider independence, evidence rules and release gates
 * stay fixed. Only the default model tier changes here. These defaults avoid
 * premium flagship pricing while retaining long-context, reasoning-capable
 * models for the quality-critical research paths.
 */
export const MODEL_POLICY_VERSION = "cost-controlled-v1-2026-08-07" as const;

/** The independent emergency council may use economy/standard seats, never premium. */
export const LLMC3_COUNCIL_TIER = "standard" as const;

export const RESEARCH_MODELS = {
  /** Opens or explicitly authorizes a canonical thesis lifecycle boundary. */
  canonicalChair: "anthropic/claude-sonnet-5",
  /** Routine daily website continuity and email synthesis. */
  dailyChair: "anthropic/claude-sonnet-4.6",
  /** Closed-file member Q&A over an already-researched dossier. */
  deskChat: "openai/gpt-5.6-terra",
  /** Independent primary-evidence scoreboard adjudication. */
  scoreboardResolver: "anthropic/claude-sonnet-5",
  /** Non-publishing continuity diagnostic. */
  thesisShadow: "qwen/qwen3-max",
  /** Schema-locked short-form copy and its independent verifier. */
  shortEditor: "anthropic/claude-sonnet-5",
  shortVerifier: "openai/gpt-5.6-terra",
} as const;

/** One cost-controlled model per independent provider family. */
export const COUNCIL_MODELS = {
  openai: "openai/gpt-5.6-terra",
  anthropic: "anthropic/claude-sonnet-5",
  anthropicFallback: "anthropic/claude-sonnet-4.6",
  google: "google/gemini-3.5-flash",
  xai: "x-ai/grok-4.3",
  moonshot: "moonshotai/kimi-k2.6",
  deepseek: "deepseek/deepseek-v4-flash",
} as const;

export const AUXILIARY_MODELS = {
  evidenceExtractor: "openai/gpt-5-mini",
  legacyIndustrySeat: "z-ai/glm-5.2",
  realtimeVoice: "gpt-realtime-2.1",
} as const;

export type ModelRequestProfile = "standard" | "reasoning" | "bounded";

/**
 * One registry drives release smoke coverage and the cost-regression test.
 * Optional means an outage is explicitly tolerated by the runtime contract.
 */
export const RUNTIME_MODEL_DEPENDENCIES = [
  { model: RESEARCH_MODELS.canonicalChair, role: "canonical website chair", profile: "standard", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.dailyChair, role: "daily website and email chair", profile: "standard", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.dailyChair, role: "legacy council chair", profile: "bounded", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.deskChat, role: "closed-file desk chat", profile: "reasoning", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.scoreboardResolver, role: "scoreboard resolver", profile: "standard", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.thesisShadow, role: "continuity shadow", profile: "standard", required: false, transport: "openrouter" },
  { model: RESEARCH_MODELS.shortEditor, role: "short editor", profile: "bounded", required: true, transport: "openrouter" },
  { model: RESEARCH_MODELS.shortVerifier, role: "short verifier", profile: "bounded", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.openai, role: "OpenAI council lane", profile: "reasoning", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.openai, role: "OpenAI exact-thesis ballot", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropic, role: "Anthropic council lane", profile: "reasoning", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropic, role: "Anthropic exact-thesis ballot", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropic, role: "legacy business seat", profile: "bounded", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropicFallback, role: "Anthropic family fallback", profile: "reasoning", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropicFallback, role: "Anthropic ballot fallback", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.anthropicFallback, role: "legacy skeptic and chair fallback", profile: "bounded", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.google, role: "Google council lane", profile: "reasoning", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.google, role: "Google exact-thesis ballot", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.google, role: "legacy expectations seat", profile: "bounded", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.xai, role: "xAI council lane", profile: "reasoning", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.xai, role: "xAI exact-thesis ballot", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.moonshot, role: "global-context shadow", profile: "reasoning", required: false, transport: "openrouter" },
  { model: COUNCIL_MODELS.deepseek, role: "DeepSeek ballot and fallback", profile: "standard", required: true, transport: "openrouter" },
  { model: COUNCIL_MODELS.deepseek, role: "legacy numbers seat and fallback", profile: "bounded", required: true, transport: "openrouter" },
  { model: AUXILIARY_MODELS.evidenceExtractor, role: "evidence extractor", profile: "standard", required: true, transport: "openrouter" },
  { model: AUXILIARY_MODELS.legacyIndustrySeat, role: "legacy industry seat", profile: "bounded", required: false, transport: "openrouter" },
  { model: AUXILIARY_MODELS.realtimeVoice, role: "realtime voice", profile: "standard", required: true, transport: "openai-realtime" },
] as const;

/**
 * Previous premium defaults. Tests assert that none remain in production
 * routing; keeping the list explicit prevents an accidental cost regression.
 */
export const DISALLOWED_PREMIUM_DEFAULTS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-sol",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.5",
  "moonshotai/kimi-k3",
] as const;

export function productionModelDefaults(): string[] {
  return [...new Set(RUNTIME_MODEL_DEPENDENCIES.map((dependency) => dependency.model))];
}
