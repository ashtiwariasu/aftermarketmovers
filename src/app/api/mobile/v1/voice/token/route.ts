import { createHash } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getDesk, isDeskServiceActive, tierOf } from "@/lib/desk";
import { buildSittingBundle } from "@/lib/sittingBundle";
import {
  REALTIME_MODEL,
  REALTIME_VOICE,
  realtimeSessionConfig,
} from "@/lib/realtimeVoice";
import { beginVoiceSession, heartbeatVoiceSession } from "@/lib/voiceStore";

export const maxDuration = 120;

function noStoreJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Vary", "Authorization, Cookie");
  return Response.json(body, { ...init, headers });
}

function jsonError(
  error: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return noStoreJson({ error, ...details }, { status });
}

/**
 * Mints a short-lived OpenAI Realtime credential for a native WebRTC client.
 * The standard OpenAI key and the immutable AMM company-file context never
 * leave the server.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return jsonError("Sign in first", 401);

  const body = (await req.json().catch(() => null)) as
    | { ticker?: unknown }
    | null;
  const ticker =
    typeof body?.ticker === "string" ? body.ticker.toUpperCase().trim() : "";
  if (!/^[A-Z.\-]{1,6}$/.test(ticker)) {
    return jsonError("A valid ticker is required", 400);
  }

  const desk = await getDesk(userId);
  if (!desk) return jsonError("No AMM Desk found", 404);
  if (!desk.tickers.includes(ticker)) {
    return jsonError(
      `${ticker} is not in AMM Desk. Add the company before talking to its thesis.`,
      403,
    );
  }
  if (!isDeskServiceActive(desk)) {
    return jsonError("Your AMM Desk access is inactive.", 403);
  }

  const tier = tierOf(desk);
  if (tier === "free") {
    return jsonError(
      "Live thesis voice is included with an active AMM subscription.",
      403,
      { code: "voice_upgrade_required" },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return jsonError(
      "Live thesis voice is not configured in this environment yet.",
      503,
      { code: "voice_not_configured" },
    );
  }

  const bundle = await buildSittingBundle(
    desk,
    ticker,
    null,
    [],
    `Explain the current ${ticker} thesis, the decisive dated evidence, material disagreement, and what would change the read.`,
  );
  if (!bundle) {
    return jsonError(`The ${ticker} company file could not be opened.`, 503);
  }

  const allowance = await beginVoiceSession(
    desk,
    ticker,
    tier,
    bundle.context,
    {
      sources: bundle.sources,
      stats: bundle.stats,
      retrieval: bundle.retrieval,
    },
  );
  if (!allowance.allowed || !allowance.sessionId) {
    const message =
      allowance.reason === "already_active"
        ? "This AMM Desk already has an active voice conversation."
        : "Today’s live thesis voice allowance has been used.";
    return jsonError(message, 429, {
      code: allowance.reason,
      allowance,
    });
  }

  try {
    const safetyIdentifier = createHash("sha256")
      .update(userId)
      .digest("hex");
    const upstream = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyIdentifier,
        },
        body: JSON.stringify({
          expires_after: {
            anchor: "created_at",
            seconds: 600,
          },
          session: realtimeSessionConfig(ticker),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = (await upstream.json().catch(() => null)) as
      | {
          value?: unknown;
          expires_at?: unknown;
          session?: { id?: unknown };
          error?: unknown;
        }
      | null;
    if (
      !upstream.ok ||
      typeof payload?.value !== "string" ||
      typeof payload.expires_at !== "number"
    ) {
      console.error(
        `[mobile-voice] client secret failed ${upstream.status}: ${JSON.stringify(payload).slice(0, 600)}`,
      );
      await heartbeatVoiceSession(
        userId,
        allowance.sessionId,
        true,
      ).catch(() => null);
      return jsonError("The live voice connection could not be started.", 502);
    }

    return noStoreJson({
      schemaVersion: 1,
      ticker,
      clientSecret: payload.value,
      expiresAt: payload.expires_at,
      realtimeSessionId:
        typeof payload.session?.id === "string" ? payload.session.id : null,
      voiceSessionId: allowance.sessionId,
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      quotaSeconds: allowance.quotaSeconds,
      remainingSeconds: allowance.remainingSeconds,
      webRtcEndpoint: "https://api.openai.com/v1/realtime/calls",
      heartbeatPath: "/api/desk/voice/heartbeat",
      toolPath: "/api/desk/voice/tool",
    });
  } catch (error) {
    await heartbeatVoiceSession(userId, allowance.sessionId, true).catch(
      () => null,
    );
    console.error(
      `[mobile-voice] token creation error: ${String(error).slice(0, 400)}`,
    );
    return jsonError("The live voice connection could not be started.", 502);
  }
}
