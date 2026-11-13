/** Request-shape transport smoke for every registered OpenRouter dependency. */
import {
  RUNTIME_MODEL_DEPENDENCIES,
  type ModelRequestProfile,
} from "../src/lib/modelPolicy";

const MODELS = [...RUNTIME_MODEL_DEPENDENCIES.reduce((models, dependency) => {
  if (dependency.transport !== "openrouter") return models;
  const key = `${dependency.model}:${dependency.profile}`;
  const current = models.get(key);
  if (current) {
    current.roles.push(dependency.role);
    current.required ||= dependency.required;
  } else {
    models.set(key, {
      model: dependency.model,
      profile: dependency.profile as ModelRequestProfile,
      roles: [dependency.role],
      required: dependency.required,
    });
  }
  return models;
}, new Map<string, {
  model: string;
  profile: ModelRequestProfile;
  roles: string[];
  required: boolean;
}>()).values()];

async function main(): Promise<void> {
  const key = (process.env.OPENROUTER_API_KEY_AMM ?? process.env.OPENROUTER_API_KEY)?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  const results: Array<Record<string, unknown>> = [];
  for (const dependency of MODELS) {
    const { model, required, profile, roles } = dependency;
    const startedAt = Date.now();
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aftermarketmovers.com",
          "X-Title": "AMM signal release smoke",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          usage: { include: true },
          ...(profile === "reasoning" ? { reasoning: { effort: "high" } } : {}),
          // The smallest real bounded council envelope is 400 tokens. A 64-token
          // probe can be consumed entirely by provider-side reasoning and
          // incorrectly report an empty transport response.
          ...(profile === "bounded" ? { max_tokens: 400 } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const payload = await response.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
        error?: { message?: unknown };
      } | null;
      const content = payload?.choices?.[0]?.message?.content;
      const ok = response.ok && typeof content === "string" && content.trim().length > 0;
      results.push({
        model,
        roles,
        profile,
        required,
        ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
        ...(ok ? {} : { error: String(payload?.error?.message ?? "empty model response").slice(0, 180) }),
      });
    } catch (error) {
      results.push({
        model,
        roles,
        profile,
        required,
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: String(error).slice(0, 180),
      });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.required === true && result.ok !== true)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
