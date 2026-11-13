import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDesk, getSittingTurns, isDeskServiceActive, setRoomSession } from "@/lib/desk";
import { getRoomHistory } from "@/lib/roomHistory";

/** Persist a room session (and optionally its title) for a ticker. */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  let body: { ticker?: string; sessionId?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const ticker = (body.ticker ?? "").toUpperCase().trim();
  const sessionId = (body.sessionId ?? "").trim();
  if (!ticker || !sessionId) {
    return NextResponse.json({ error: "ticker and sessionId required" }, { status: 400 });
  }
  const desk = await getDesk(userId);
  if (!desk) {
    return NextResponse.json({ error: "No desk" }, { status: 404 });
  }
  if (!isDeskServiceActive(desk)) return NextResponse.json({ error: "AMM subscription required" }, { status: 402 });
  await setRoomSession(userId, ticker, sessionId, body.title);
  return NextResponse.json({ ok: true });
}

/** Load a room session's transcript (for switching sessions in the chat history). */
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  const desk = await getDesk(userId);
  if (!desk) return NextResponse.json({ error: "No desk" }, { status: 404 });
  if (!isDeskServiceActive(desk)) return NextResponse.json({ error: "AMM subscription required" }, { status: 402 });

  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").toUpperCase().trim();
  const sessionId = (req.nextUrl.searchParams.get("session") ?? "").trim();
  const known =
    desk.roomList?.[ticker]?.some((s) => s.id === sessionId) ||
    desk.rooms?.[ticker] === sessionId;
  if (!ticker || !sessionId || !known) {
    return NextResponse.json({ error: "unknown session" }, { status: 404 });
  }
  // Audited-room sessions live in Firestore; legacy llmc3 sessions proxy through.
  if (sessionId.startsWith("local-")) {
    const turns = await getSittingTurns(userId, sessionId);
    return NextResponse.json({
      sessionId,
      messages: turns.map((t) => ({
        role: t.role === "member" ? "user" : "assistant",
        content: t.text,
        ...(t.draft ? {
          transcript: {
            lead: t.lead ?? "",
            ...(t.chair ? { chair: t.chair } : {}),
            draft: t.draft,
            audits: t.audits ?? [],
          },
        } : {}),
      })),
    });
  }
  const messages = await getRoomHistory(sessionId, desk.email);
  return NextResponse.json({ sessionId, messages });
}
