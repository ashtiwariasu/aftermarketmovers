import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "crypto";
import {
  appendSittingTurns,
  consumeSittings,
  getDesk,
  getSittingTurns,
  setRoomSession,
} from "@/lib/desk";
import { TIERS, nextTier } from "@/lib/tiers";
import { buildSittingBundle } from "@/lib/sittingBundle";
import { runSittingRoom } from "@/lib/sittingRoom";

export const maxDuration = 900;

/**
 * One grounded chat answer, streamed. One POST = one question:
 * gate (the meter transacts server-side BEFORE anything runs) → intent-matched
 * company-file bundle → one source-gated answer. Events are Server-Sent Events:
 *   {type:"line", text}    — narration in the Desk's voice
 *   {type:"notes", text}   — reserved legacy event
 *   {type:"answer", text}  — verified final answer
 *   {type:"wall", ...}     — meter empty; nothing ran, nothing charged
 *   {type:"done", ...}     — answer complete + transcript + usage
 *   {type:"error", text}
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new Response(JSON.stringify({ error: "Sign in first" }), { status: 401 });

  let body: { ticker?: string; question?: string; sessionId?: string; documentIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400 });
  }
  const sym = (body.ticker ?? "").toUpperCase().trim();
  const question = (body.question ?? "").trim().slice(0, 4000);
  if (!/^[A-Z.\-]{1,6}$/.test(sym) || !question) {
    return new Response(JSON.stringify({ error: "ticker and question required" }), { status: 400 });
  }

  const desk = await getDesk(userId);
  if (!desk) return new Response(JSON.stringify({ error: "No desk" }), { status: 404 });
  if (!desk.tickers.includes(sym)) {
    // The file wall: chat only answers from files this desk holds open.
    return new Response(
      JSON.stringify({ error: `${sym} is not in AMM Desk. Add the company before asking a question.` }),
      { status: 403 }
    );
  }

  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.filter((x) => /^[0-9a-fA-F-]{10,40}$/.test(String(x))).slice(0, 60)
    : null;
  const sessionId =
    body.sessionId && /^local-[0-9a-f-]{10,40}$/.test(body.sessionId)
      ? body.sessionId
      : `local-${randomUUID()}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const line = (text: string) => send({ type: "line", text });

      try {
        // ---- A. the gate: the meter transacts before anything runs ----
        const verdict = await consumeSittings(userId, 1);
        if (!verdict) throw new Error("desk vanished");
        if (!verdict.allowed) {
          const up = nextTier(verdict.tier);
          send({
            type: "wall",
            used: verdict.used,
            cap: verdict.cap,
            wall: up ? { label: TIERS[up].label, price: TIERS[up].price, blurb: TIERS[up].blurb } : null,
          });
          controller.close();
          return;
        }

        // ---- B. the file ----
        line(`Opening your ${sym} file.`);
        const priorTurns = await getSittingTurns(userId, sessionId);
        const bundle = await buildSittingBundle(desk, sym, documentIds, priorTurns, question);
        if (!bundle) {
          send({ type: "error", text: "Couldn't open the file just now — try again in a moment." });
          controller.close();
          return;
        }
        if (bundle.retrieval.eligibleSources > 0) {
          line(
            `All ${bundle.retrieval.eligibleSources} selected sources are available. ` +
            `Matching this question to the strongest evidence…`
          );
          line(
            `Matched ${bundle.retrieval.matchedSources} sources and ` +
            `${bundle.retrieval.matchedPassages} passages for ${bundle.retrieval.intent}.`
          );
        }
        line(`Reading: ${bundle.sources.join(", ")}.`);
        for (const s of bundle.stats.slice(0, 2)) line(s);

        // ---- C. one grounded answer, released only after deterministic verification ----
        const result = await runSittingRoom(question, bundle.context, {
          line,
          notes: (t) => send({ type: "notes", text: t }),
          answer: (t) => send({ type: "answer", text: t }),
        });
        if (!result) {
          send({
            type: "error",
            text:
              "No answer was shown because AMM could not bind every material claim to an admitted dated source. " +
              "The file remains unchanged; try a narrower question.",
          });
          controller.close();
          return;
        }

        // ---- E. persist + done ----
        const now = Date.now();
        await appendSittingTurns(userId, sessionId, sym, [
          { at: now, role: "member", text: question },
          {
            at: now + 1,
            role: "desk",
            text: result.answer,
            lead: result.transcript.lead,
            ...(result.transcript.chair ? { chair: result.transcript.chair } : {}),
            draft: result.transcript.draft,
            audits: result.transcript.audits,
          },
        ]).catch((e) => console.error(`[sitting] persist failed: ${String(e).slice(0, 120)}`));
        await setRoomSession(userId, sym, sessionId, priorTurns.length === 0 ? question.slice(0, 60) : undefined).catch(
          () => {}
        );

        send({
          type: "done",
          sessionId,
          answer: result.answer,
          transcript: result.transcript,
          used: verdict.used,
          cap: verdict.cap,
        });
      } catch (e) {
        console.error(`[sitting] ${sym}: ${String(e).slice(0, 200)}`);
        send({ type: "error", text: "AMM Desk hit an error. Try again in a moment." });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
