import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { getDesk, isDeskServiceActive } from "@/lib/desk";
import { runSittingRoom } from "@/lib/sittingRoom";
import { appendVoiceTurn, getVoiceSession, heartbeatVoiceSession } from "@/lib/voiceStore";
import { citationsFromAnswer, spokenAnswerFromMarkdown } from "@/lib/voiceAnswer";

export const maxDuration = 900;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in first" }, { status: 401 });
  let body: { sessionId?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const sessionId = body.sessionId ?? "";
  const question = (body.question ?? "").trim().slice(0, 4_000);
  if (!/^voice-[0-9a-f-]{20,80}$/.test(sessionId) || !question) {
    return Response.json({ error: "Voice session and question are required" }, { status: 400 });
  }
  const [desk, session] = await Promise.all([getDesk(userId), getVoiceSession(userId, sessionId)]);
  if (!desk || !session || session.deskId !== userId || session.endedAt) {
    return Response.json({ error: "Voice session is no longer active" }, { status: 409 });
  }
  if (!isDeskServiceActive(desk)) {
    return Response.json({ error: "AMM subscription required" }, { status: 402 });
  }
  if (!desk.tickers.includes(session.ticker)) {
    return Response.json({ error: "The company is no longer in AMM Desk" }, { status: 403 });
  }
  const allowance = await heartbeatVoiceSession(userId, sessionId, false);
  if (!allowance?.allowed) {
    return Response.json({
      error: "Today’s live thesis voice allowance has been used.",
      spokenAnswer: "Today’s live thesis voice allowance has been used. The written AMM file remains available.",
      allowance,
    }, { status: 429 });
  }

  const execute = async (line: (text: string) => void) => {
    const result = await runSittingRoom(question, session.context, {
      line,
      notes: () => {},
      // The complete answer is deliberately withheld here. Realtime receives
      // it only through the terminal, source-gated tool result below.
      answer: () => {},
    });
    if (!result) return null;

    const spokenAnswer = spokenAnswerFromMarkdown(result.answer);
    const citations = citationsFromAnswer(result.answer);
    await appendVoiceTurn(userId, sessionId, {
      at: Date.now(),
      question,
      answer: result.answer,
      spokenAnswer,
      citations,
    }).catch((error) =>
      console.error(`[voice] transcript persist failed: ${String(error).slice(0, 200)}`)
    );
    return {
      ticker: session.ticker,
      answer: result.answer,
      spokenAnswer,
      citations,
      evidenceCutoff: session.startedAt,
      allowance,
    };
  };

  if (req.headers.get("accept")?.includes("text/event-stream")) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        let keepAlive: ReturnType<typeof setInterval> | null = null;
        const send = (payload: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            closed = true;
            if (keepAlive) clearInterval(keepAlive);
          }
        };
        const line = (text: string) => send({ type: "line", text });
        // Keep proxies and radios alive during a long source-gated model call.
        // Comments are ignored by the client and expose no internal reasoning.
        keepAlive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": source-check-active\n\n"));
          } catch {
            closed = true;
            if (keepAlive) clearInterval(keepAlive);
          }
        }, 15_000);

        try {
          line(`Matching this question to ${session.ticker}’s selected company file…`);
          const result = await execute(line);
          if (!result) {
            send({
              type: "error",
              text:
                "AMM could not bind a complete answer to the admitted dated sources. " +
                "Try a narrower question about the thesis, evidence, risk, or what would change the read.",
            });
            return;
          }
          send({ type: "done", ...result });
        } catch (error) {
          console.error(`[voice] streamed tool failed: ${String(error).slice(0, 200)}`);
          send({
            type: "error",
            text:
              "AMM could not complete the dated-source check. " +
              "The company file is unchanged; try again in a moment.",
          });
        } finally {
          if (keepAlive) clearInterval(keepAlive);
          closed = true;
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
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const result = await execute(() => {});
  if (!result) {
    return Response.json({
      error: "No answer passed the dated-source check.",
      spokenAnswer:
        "AMM could not bind a complete answer to the admitted dated sources. Try a narrower question about the thesis, evidence, risk, or what would change the read.",
      allowance,
    }, { status: 422 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
