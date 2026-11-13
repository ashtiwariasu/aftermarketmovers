import { NextRequest, NextResponse } from "next/server";
import { setEmailOptOut } from "@/lib/desk";
import { validUnsubscribeToken } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

function page({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: string;
}): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AMM — Morning Notes</title>
<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#F4F1EA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:420px;background:#FFFDF8;border:2px solid #16150F;border-radius:14px;box-shadow:5px 5px 0 #16150F;padding:28px;text-align:center;">
    <img src="https://aftermarketmovers.com/fox-note.png" width="54" alt="">
    <h1 style="margin:14px 0 6px;font-size:22px;color:#16150F;">${title}</h1>
    <p style="margin:0;font-size:14px;color:#57544a;line-height:1.5;">${message}</p>
    ${action ? `<form method="post" action="${action}"><button type="submit" style="display:inline-block;margin-top:18px;background:#FF4D1F;color:#F4F1EA;font-weight:800;padding:12px 24px;border-radius:9px;border:2px solid #16150F;cursor:pointer;">Turn off Morning Notes</button></form>` : `<a href="https://aftermarketmovers.com/desk" style="display:inline-block;margin-top:18px;background:#FF4D1F;color:#F4F1EA;font-weight:800;text-decoration:none;padding:12px 24px;border-radius:9px;border:2px solid #16150F;">Back to AMM Desk →</a>`}
  </div>
</div>`;
}

function params(req: NextRequest): { deskId: string; token: string } | null {
  const d = req.nextUrl.searchParams.get("d") ?? "";
  const t = req.nextUrl.searchParams.get("t") ?? "";
  return /^[0-9a-zA-Z_-]{10,64}$/.test(d) && validUnsubscribeToken(d, t)
    ? { deskId: d, token: t }
    : null;
}

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Browser/email scanners may GET this link: show confirmation, never mutate. */
export async function GET(req: NextRequest) {
  const parsed = params(req);
  if (!parsed) {
    return htmlResponse(page({
      title: "That link is not valid.",
      message: "It may be stale. Manage Morning Note delivery from AMM Desk instead.",
    }), 400);
  }
  const action = `/api/email/unsub?d=${encodeURIComponent(parsed.deskId)}&t=${encodeURIComponent(parsed.token)}`;
  return htmlResponse(page({
    title: "Turn off Morning Notes?",
    message: "AMM Desk, your daily research and question history will keep working. Only the morning email will stop.",
    action,
  }));
}

/** RFC 8058 one-click unsubscribe and the explicit browser confirmation. */
export async function POST(req: NextRequest) {
  const parsed = params(req);
  if (!parsed) {
    return htmlResponse(page({
      title: "That link is not valid.",
      message: "It may be stale. Manage Morning Note delivery from AMM Desk instead.",
    }), 400);
  }
  const ok = await setEmailOptOut(parsed.deskId);
  return htmlResponse(page({
    title: ok ? "Morning Notes are off." : "That desk wasn't found.",
    message: ok
      ? "AMM Desk keeps working — daily research and question history included — but the morning email has stopped."
      : "The link may be stale. Manage delivery from AMM Desk instead.",
  }), ok ? 200 : 404);
}
