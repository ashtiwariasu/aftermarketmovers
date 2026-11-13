import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import {
  getDesk,
  isDeskServiceActive,
  appendMessages,
  incrementCouncils,
  type DeskMessage,
} from "@/lib/desk";
import { generateReply } from "@/lib/deskBrain";

export const maxDuration = 170;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  const desk = await getDesk(userId);
  if (!desk) {
    return NextResponse.json({ error: "No desk yet" }, { status: 404 });
  }
  if (!isDeskServiceActive(desk)) {
    return NextResponse.json(
      { error: "AMM is $25/month. Subscribe to ask the council; your existing research remains saved." },
      { status: 402 },
    );
  }

  let body: { text?: string; ticker?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const text = (body.text ?? "").trim().slice(0, 500);
  if (!text) {
    return NextResponse.json({ error: "Empty question" }, { status: 400 });
  }
  const ticker = (body.ticker ?? "").toUpperCase().trim() || undefined;

  const question: DeskMessage = {
    at: Date.now(),
    role: "user",
    kind: "question",
    text,
    ...(ticker ? { ticker } : {}),
  };

  const user = await currentUser();
  const reply = await generateReply(text, {
    tickers: desk.tickers,
    firstName: user?.firstName ?? undefined,
    ticker,
  });
  if (ticker) reply.ticker = ticker;

  if (reply.kind === "council") {
    await incrementCouncils(userId);
  }
  await appendMessages(userId, [question, reply]);
  return NextResponse.json({ messages: [question, reply] });
}
