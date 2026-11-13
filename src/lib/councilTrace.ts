/**
 * Council deliberation state machine — a direct port of llmc3's useCouncil
 * reducer so the Night Desk renders the same stages the llmcouncil UI does.
 * Pure: feed stream events, read computed state.
 */

export interface CouncilModelResult {
  model: string;
  time_ms: number;
  error?: string;
  timed_out?: boolean;
  timeout_reason?: string;
  skipped?: boolean;
}

export interface CouncilEvalResult {
  reviewer: string;
  rankings: string[];
  time_ms: number;
  error?: string;
  timed_out?: boolean;
  skipped?: boolean;
}

export interface CouncilAggregate {
  model: string;
  average_rank: number;
  rankings_count: number;
}

export interface CouncilTraceState {
  active: boolean;
  stage: 0 | 1 | 2 | 3; // 0=idle, 1=answers, 2=peer review, 3=complete
  models: string[];
  characterization: string | null;
  tier: string;
  stage1Live: Record<string, string>;
  stage1Done: Record<string, CouncilModelResult>;
  stage1Fastest: string | null;
  labelToModel: Record<string, string>;
  stage2Live: Record<string, string>;
  stage2Done: Record<string, CouncilEvalResult>;
  aggregate: CouncilAggregate[];
  consensus: number;
  winner: string | null;
  elapsedMs: number;
}

export const INITIAL_COUNCIL_STATE: CouncilTraceState = {
  active: false,
  stage: 0,
  models: [],
  characterization: null,
  tier: "",
  stage1Live: {},
  stage1Done: {},
  stage1Fastest: null,
  labelToModel: {},
  stage2Live: {},
  stage2Done: {},
  aggregate: [],
  consensus: 0,
  winner: null,
  elapsedMs: 0,
};

export interface StreamEvent {
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface CouncilEventMetadata {
  models?: string[];
  tier?: string;
  user_visible_characterization?: string;
  reason?: string;
  model?: string;
  stage?: number;
  replacement_for?: string;
  skipped?: boolean;
  time_ms?: number;
  error?: string;
  timed_out?: boolean;
  timeout_reason?: string;
  fastest?: string;
  label_to_model?: Record<string, string>;
  reviewer?: string;
  rankings?: string[];
  aggregate?: CouncilAggregate[];
  consensus?: number;
  winner?: string;
  elapsed_ms?: number;
}

export function shortModel(id: string): string {
  return id.includes("/") ? id.split("/")[1] : id;
}

/** Reduce one WS event into the council trace state. Returns the next state
 *  (same reference if the event is not a council event). */
export function reduceCouncilEvent(
  prev: CouncilTraceState,
  event: StreamEvent
): CouncilTraceState {
  const meta = (event.metadata ?? {}) as CouncilEventMetadata;
  switch (event.type) {
    case "council_assembly": {
      return {
        ...INITIAL_COUNCIL_STATE,
        active: true,
        stage: 1,
        models: meta.models || [],
        tier: meta.tier || "",
        characterization: meta.user_visible_characterization || meta.reason || null,
      };
    }
    case "council_start":
      return {
        ...INITIAL_COUNCIL_STATE,
        active: true,
        stage: 1,
        models: meta.models || [],
        characterization: prev.characterization,
        tier: prev.tier,
      };
    case "council_delta": {
      const model = meta.model || "";
      const text = event.content || "";
      const stage = meta.stage || 1;
      const replacementFor = meta.replacement_for as string | undefined;
      if (stage === 1) {
        const stage1Live = { ...prev.stage1Live };
        if (replacementFor) delete stage1Live[replacementFor];
        if (text) stage1Live[model] = (stage1Live[model] || "") + text;
        let models = replacementFor
          ? prev.models.map((m) => (m === replacementFor ? model : m))
          : prev.models;
        if (model && !models.includes(model)) models = [...models, model];
        const stage1Done = { ...prev.stage1Done };
        if (replacementFor) delete stage1Done[replacementFor];
        return { ...prev, models, stage1Live, stage1Done };
      }
      const stage2Live = { ...prev.stage2Live };
      if (text) stage2Live[model] = "reviewing";
      return { ...prev, stage2Live };
    }
    case "council_model_done": {
      const model = meta.model || "";
      if (meta.skipped && model) {
        const stage1Live = { ...prev.stage1Live };
        const stage1Done = { ...prev.stage1Done };
        delete stage1Live[model];
        delete stage1Done[model];
        return {
          ...prev,
          models: prev.models.filter((m) => m !== model),
          stage1Live,
          stage1Done,
        };
      }
      const models =
        model && !prev.models.includes(model) ? [...prev.models, model] : prev.models;
      return {
        ...prev,
        models,
        stage1Done: {
          ...prev.stage1Done,
          [model]: {
            model,
            time_ms: meta.time_ms ?? 0,
            error: meta.error,
            timed_out: meta.timed_out,
            timeout_reason: meta.timeout_reason,
            skipped: meta.skipped,
          },
        },
      };
    }
    case "council_stage_done":
      if (meta.stage === 1) return { ...prev, stage1Fastest: meta.fastest ?? null };
      return prev;
    case "council_eval_start": {
      const labelToModel = meta.label_to_model || {};
      const inferred = Object.values(labelToModel).filter(
        (m): m is string => typeof m === "string" && m.length > 0
      );
      return {
        ...prev,
        stage: 2,
        models: inferred.length > 0 ? inferred : prev.models,
        labelToModel,
        stage2Live: {},
      };
    }
    case "council_eval_done": {
      const reviewer = meta.reviewer || "";
      const stage2Live = { ...prev.stage2Live };
      if (reviewer && meta.skipped) delete stage2Live[reviewer];
      const models =
        reviewer && !prev.models.includes(reviewer)
          ? [...prev.models, reviewer]
          : prev.models;
      return {
        ...prev,
        models,
        stage2Live,
        stage2Done: {
          ...prev.stage2Done,
          [reviewer]: {
            reviewer,
            rankings: meta.rankings || [],
            time_ms: meta.time_ms ?? 0,
            error: meta.error,
            timed_out: meta.timed_out,
            skipped: meta.skipped,
          },
        },
      };
    }
    case "council_complete":
      return {
        ...prev,
        stage: 3,
        active: false,
        aggregate: meta.aggregate || [],
        consensus: meta.consensus || 0,
        winner: meta.winner || null,
        elapsedMs: meta.elapsed_ms || 0,
      };
    default:
      return prev;
  }
}

// ---- processing steps (search / fetch / research activity) ----

export interface RoomStep {
  id: string;
  icon: "search" | "fetch" | "research" | "council" | "doc" | "generic";
  text: string;
  detail?: string;
  done: boolean;
  startedAt: number;
  durationMs?: number;
}

export function stepIconFor(toolName: string): RoomStep["icon"] {
  const t = toolName.toLowerCase();
  if (t.includes("search")) return "search";
  if (t.includes("fetch") || t.includes("url") || t.includes("browse")) return "fetch";
  if (t.includes("research")) return "research";
  if (t.includes("council")) return "council";
  if (t.includes("doc") || t.includes("file") || t.includes("read")) return "doc";
  return "generic";
}

export function stepGlyph(icon: RoomStep["icon"]): string {
  switch (icon) {
    case "search": return "⌕";
    case "fetch": return "↧";
    case "research": return "≡";
    case "council": return "◉";
    case "doc": return "▤";
    default: return "·";
  }
}

export function stepLabelFor(toolName: string, args?: string): { text: string; detail?: string } {
  const icon = stepIconFor(toolName);
  let detail: string | undefined;
  if (args) {
    try {
      const parsed = JSON.parse(args);
      detail =
        parsed.query || parsed.q || parsed.url || parsed.question || parsed.topic || undefined;
    } catch {
      detail = args.length < 120 ? args : undefined;
    }
  }
  switch (icon) {
    case "search": return { text: "Searching the web", detail };
    case "fetch": return { text: "Reading a source", detail };
    case "research": return { text: "Running research", detail };
    case "council": return { text: "AI analysts are reviewing the evidence", detail };
    case "doc": return { text: "Reading documents", detail };
    default: return { text: toolName.replace(/_/g, " "), detail };
  }
}
