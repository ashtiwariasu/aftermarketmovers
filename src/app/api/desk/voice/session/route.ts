import { createHash } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getDesk, isDeskServiceActive, tierOf } from "@/lib/desk";
import { buildSittingBundle } from "@/lib/sittingBundle";
import { realtimeSessionConfig } from "@/lib/realtimeVoice";
import { beginVoiceSession, heartbeatVoiceSession } from "@/lib/voiceStore";

export const maxDuration = 120;

function jsonError(error: string, status: number, details?: Record<string, unknown>) {
  return Response.json({ error, ...details }, { status });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return jsonError("Sign in first", 401);
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").toUpperCase().trim();
  if (!/^[A-Z.\-]{1,6}$/.test(ticker)) return jsonError("A valid ticker is required", 400);

  const desk = await getDesk(userId);
  if (!desk) return jsonError("No AMM Desk found", 404);
  if (!desk.tickers.includes(ticker)) {
    return jsonError(`${ticker} is not in AMM Desk. Add the company before talking to its thesis.`, 403);
  }
  if (!isDeskServiceActive(desk)) return jsonError("Your AMM Desk access is inactive.", 403);
  const tier = tierOf(desk);
  if (tier === "free") {
    return jsonError("Live thesis voice is included with an active AMM subscription.", 403, {
      code: "voice_upgrade_required",
    });
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return jsonError("Live thesis voice is not configured in this environment yet.", 503, {
      code: "voice_not_configured",
    });
  }

  const sdp = await req.text();
  if (!sdp.includes("v=0") || sdp.length > 100_000) return jsonError("Invalid WebRTC offer", 400);

  const bundle = await buildSittingBundle(
    desk,
    ticker,
    null,
    [],
    `Explain the current ${ticker} thesis, the decisive dated evidence, material disagreement, and what would change the read.`,
  );
  if (!bundle) return jsonError(`The ${ticker} company file could not be opened.`, 503);

  const allowance = await beginVoiceSession(desk, ticker, tier, bundle.context, {
    sources: bundle.sources,
    stats: bundle.stats,
    retrieval: bundle.retrieval,
  });
  if (!allowance.allowed || !allowance.sessionId) {
    const message = allowance.reason === "already_active"
      ? "This AMM Desk already has an active voice conversation."
      : "Today’s live thesis voice allowance has been used.";
    return jsonError(message, 429, { code: allowance.reason, allowance });
  }

  try {
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(realtimeSessionConfig(ticker)));
    const safetyIdentifier = createHash("sha256").update(userId).digest("hex");
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": safetyIdentifier,
      },
      body: form,
      cache: "no-store",
    });
    const responseBody = await upstream.text();
    if (!upstream.ok) {
      console.error(`[voice] realtime create failed ${upstream.status}: ${responseBody.slice(0, 500)}`);
      await heartbeatVoiceSession(userId, allowance.sessionId, true).catch(() => null);
      return jsonError("The live voice connection could not be started.", 502);
    }
    return new Response(responseBody, {
      status: 200,
      headers: {
        "Content-Type": "application/sdp",
        "Cache-Control": "no-store",
        "X-AMM-Voice-Session": allowance.sessionId,
        "X-AMM-Voice-Remaining": String(allowance.remainingSeconds),
        "X-AMM-Voice-Limit": String(allowance.quotaSeconds),
      },
    });
  } catch (error) {
    await heartbeatVoiceSession(userId, allowance.sessionId, true).catch(() => null);
    console.error(`[voice] realtime connection error: ${String(error).slice(0, 300)}`);
    return jsonError("The live voice connection could not be started.", 502);
  }
}
