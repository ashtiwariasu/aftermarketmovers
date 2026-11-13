import type { RoomMsg } from "@/components/CouncilRoom";

interface Llmc3Message {
  role?: string;
  content?: unknown;
  attachments?: Array<{ filename?: string }>;
}

/** Load a stock room's transcript from its llmcouncil session. */
export async function getRoomHistory(
  sessionId: string,
  email: string
): Promise<RoomMsg[]> {
  const base = process.env.LLMC3_COUNCIL_URL;
  if (!base) return [];
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(
        sessionId
      )}/messages?email=${encodeURIComponent(email)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const json = await res.json();
    const messages: Llmc3Message[] = Array.isArray(json?.messages)
      ? json.messages
      : [];
    return messages
      .filter(
        (m): m is Llmc3Message & { role: string; content: string } =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0
      )
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        attachments: (m.attachments ?? [])
          .filter((a) => a.filename)
          .map((a) => ({ filename: a.filename! })),
      }));
  } catch {
    return [];
  }
}
