import { auth, currentUser } from "@clerk/nextjs/server";
import {
  getDesk,
  isDeskServiceActive,
  MORNING_NOTE_SEND_TIME,
  MORNING_NOTE_SEND_TIME_ZONE,
  tierOf,
  trialStateOf,
} from "@/lib/desk";
import { buildDeskPriorityCards } from "@/lib/deskPresentation";
import { getVoiceAllowance } from "@/lib/voiceStore";

export const dynamic = "force-dynamic";

function noStoreJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Vary", "Authorization, Cookie");
  return Response.json(body, { ...init, headers });
}

/**
 * Stable, server-authored AMM Desk contract for native clients.
 *
 * The mobile app renders these same card objects; it must not infer a thesis,
 * confidence, priority, or lifecycle state from raw market data.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return noStoreJson({ error: "Sign in first" }, { status: 401 });

  const desk = await getDesk(userId);
  if (!desk) return noStoreJson({ error: "No AMM Desk found" }, { status: 404 });

  const now = new Date();
  const tier = tierOf(desk);
  const [user, cards, voice] = await Promise.all([
    currentUser(),
    buildDeskPriorityCards(desk, now),
    getVoiceAllowance(desk, tier).catch((error) => {
      console.error("[mobile-desk] voice allowance read failed", error);
      return null;
    }),
  ]);

  return noStoreJson({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    member: {
      firstName: user?.firstName ?? desk.email.split("@")[0],
    },
    desk: {
      tier,
      active: isDeskServiceActive(desk, now.getTime()),
      trial: trialStateOf(desk, now.getTime()),
      tickers: desk.tickers,
      noteTime: MORNING_NOTE_SEND_TIME,
      timeZone: MORNING_NOTE_SEND_TIME_ZONE,
    },
    voice,
    cards,
  });
}
