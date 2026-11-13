import { NextRequest, NextResponse } from "next/server";
import { getOnboardingUser, setOnboardingEmailOptOut } from "@/lib/onboarding";
import { syncResendOnboardingContact } from "@/lib/resendContacts";
import { validUnsubscribeToken } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

function parsed(request: NextRequest): { id: string; token: string } | null {
  const id = request.nextUrl.searchParams.get("d") ?? "";
  const token = request.nextUrl.searchParams.get("t") ?? "";
  return /^[0-9a-zA-Z_-]{10,64}$/.test(id) && validUnsubscribeToken(id, token) ? { id, token } : null;
}

function page(title: string, message: string, action?: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AMM — Setup reminders</title>
<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#F4F1EA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:420px;background:#FFFDF8;border:2px solid #16150F;border-radius:14px;box-shadow:5px 5px 0 #16150F;padding:28px;text-align:center;">
    <div style="font-size:24px;font-weight:900;">AMM<span style="color:#FF4D1F;font-size:14px;">▲</span></div>
    <h1 style="margin:18px 0 7px;font-size:22px;">${title}</h1><p style="margin:0;color:#57544a;line-height:1.5;">${message}</p>
    ${action ? `<form method="post" action="${action}"><button type="submit" style="margin-top:20px;background:#FF4D1F;color:#FFFDF8;font-weight:800;padding:12px 22px;border-radius:9px;border:2px solid #16150F;cursor:pointer;">Turn off setup reminders</button></form>` : `<a href="https://aftermarketmovers.com" style="display:inline-block;margin-top:20px;color:#16150F;">Back to AMM →</a>`}
  </div>
</div>`;
}

function response(html: string, status = 200) {
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const value = parsed(request);
  if (!value) return response(page("That link is not valid.", "It may be stale."), 400);
  const action = `/api/onboarding/unsubscribe?d=${encodeURIComponent(value.id)}&t=${encodeURIComponent(value.token)}`;
  return response(page("Turn off setup reminders?", "This only stops reminders to finish creating AMM Desk.", action));
}

export async function POST(request: NextRequest) {
  const value = parsed(request);
  if (!value) return response(page("That link is not valid.", "It may be stale."), 400);
  const user = await getOnboardingUser(value.id);
  const ok = await setOnboardingEmailOptOut(value.id);
  if (ok && user) await syncResendOnboardingContact(user, "unsubscribed");
  return response(page(ok ? "Setup reminders are off." : "Account not found.", ok
    ? "You can still subscribe to AMM whenever you are ready."
    : "This reminder may already have expired."), ok ? 200 : 404);
}
