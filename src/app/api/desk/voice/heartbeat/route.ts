import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { heartbeatVoiceSession } from "@/lib/voiceStore";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in first" }, { status: 401 });
  let body: { sessionId?: string; finish?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const sessionId = body.sessionId ?? "";
  if (!/^voice-[0-9a-f-]{20,80}$/.test(sessionId)) {
    return Response.json({ error: "Invalid voice session" }, { status: 400 });
  }
  const allowance = await heartbeatVoiceSession(userId, sessionId, Boolean(body.finish));
  if (!allowance) return Response.json({ error: "Voice session is no longer active" }, { status: 409 });
  return Response.json({ allowance }, { headers: { "Cache-Control": "no-store" } });
}

