import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ammEnvironment } from "@/lib/environment";

// The desk page owns its signed-out redirect to /desk/new. Protecting the page
// here makes Clerk rewrite signed-out requests to an internal route, which can
// surface as a 404 before the page redirect runs. Desk APIs remain protected.
const isProtected = createRouteMatcher(["/api/desk(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
  const environment = ammEnvironment();
  if (environment === "development") {
    const path = req.nextUrl.pathname;
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);

    if (mutating && path.startsWith("/api/billing/")) {
      return NextResponse.json({ error: "Billing is disabled in the AMM development environment." }, { status: 423 });
    }

    // The data plane is intentionally shared. Browser writes are therefore
    // restricted to named test identities instead of trusting the hostname.
    if (
      mutating &&
      path.startsWith("/api/") &&
      !path.startsWith("/api/cron/") &&
      !path.startsWith("/api/webhooks/")
    ) {
      const { userId } = await auth();
      const allowed = new Set(
        (process.env.AMM_DEV_USER_ALLOWLIST ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      if (!userId || !allowed.has(userId)) {
        return NextResponse.json(
          { error: "This account is read-only in the AMM development environment." },
          { status: 403 },
        );
      }
    }

    // Schedulers are provisioned paused. A deliberate fleet test needs a
    // second dev-only credential as well as the normal cron token, preventing
    // an accidental scheduler enable from touching the shared data plane.
    if (path.startsWith("/api/cron/")) {
      const expected = process.env.AMM_DEV_FLEET_TOKEN?.trim();
      if (!expected || req.headers.get("x-amm-dev-fleet-token") !== expected) {
        return NextResponse.json({ error: "Development fleet jobs are locked." }, { status: 423 });
      }
    }

    // Provider webhooks must target production. Local replay is still
    // possible with an explicit dev credential.
    if (mutating && path.startsWith("/api/webhooks/")) {
      const expected = process.env.AMM_DEV_WEBHOOK_TOKEN?.trim();
      if (!expected || req.headers.get("x-amm-dev-webhook-token") !== expected) {
        return NextResponse.json({ error: "Development webhooks are locked." }, { status: 423 });
      }
    }
  }
  // Signed-in members land on their desk, not the marketing page.
  if (req.nextUrl.pathname === "/") {
    const { userId } = await auth();
    if (userId) return NextResponse.redirect(new URL("/desk", req.url));
  }
});

export const config = {
  matcher: [
    // Metadata files must be fetched directly by crawlers, without Clerk.
    "/((?!_next|sitemap\\.xml|robots\\.txt|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
