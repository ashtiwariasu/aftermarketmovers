"use client";

import { readFirstTouch } from "@/components/FirstTouch";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SignInButton, useClerk, useUser } from "@clerk/nextjs";
import { useUsage, TierChip } from "@/components/UsageMeter";
import Tri from "@/components/Tri";
import { TIERS, nextTier, type Tier } from "@/lib/tiers";
import { captureAnalyticsEvent } from "@/lib/analytics";
import { beginNavigationFeedback } from "@/lib/navigationFeedback";

const SUGGESTED = ["NVDA", "GOOGL", "MSFT", "AAPL", "TSLA", "META", "AMZN", "AMD", "PLTR"];

const PROVISION_STEPS = [
  "Seating your analysts…",
  "Pulling latest exchange data…",
  "Building company baselines…",
  "Scheduling company events…",
  "Scheduling your first Morning Note…",
];

export default function NewDesk() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();
  const [tickers, setTickers] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [coverageNotice, setCoverageNotice] = useState<string | null>(null);
  const [checkingTicker, setCheckingTicker] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [hits, setHits] = useState<Array<{ symbol: string; name: string }>>([]);

  // Signed-in paid members get their plan envelope. Unpaid accounts have a
  // zero-cap entitlement and see checkout before the stock picker.
  const usage = useUsage();
  const cap = Math.max(usage?.companies.cap ?? TIERS.free.companies, usage?.companies.used ?? 0);
  const tierLabel = usage?.label ?? "AMM";

  // Public links carry an explicit purchase intent and enter checkout after
  // authentication. Ultra remains accepted for legacy/internal links only.
  const [upgraded, setUpgraded] = useState<string | null>(null);
  const [purchaseIntent, setPurchaseIntent] = useState<string | null>(null);
  const [payingFor, setPayingFor] = useState<Tier | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      setUpgraded(q.get("upgraded"));
      setPurchaseIntent(q.get("purchase"));
      // Ticker that triggered an upgrade rides through Stripe and lands picked.
      const add = q.get("add");
      if (add && /^[A-Z.]{1,6}$/i.test(add)) {
        setTickers((t) => (t.includes(add.toUpperCase()) ? t : [...t, add.toUpperCase()]));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Minimum clicks: signed-out arrivals get the sign-in modal immediately
  // (Google or email code — the page behind it is the fallback).
  const clerk = useClerk();
  const { isLoaded } = useUser();
  const modalOpened = useRef(false);
  useEffect(() => {
    if (!isLoaded || isSignedIn || modalOpened.current) return;
    modalOpened.current = true;
    clerk.openSignIn({
      forceRedirectUrl: window.location.pathname + window.location.search,
    });
  }, [isLoaded, isSignedIn, clerk]);

  // Existing members land with their desk preloaded — adding a stock never
  // silently drops the ones already on watch.
  const deskLoaded = useRef(false);
  useEffect(() => {
    if (!isSignedIn || deskLoaded.current) return;
    deskLoaded.current = true;
    fetch("/api/desk", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tickers?: string[] } | null) => {
        if (!d?.tickers?.length) return;
        setTickers((t) => [...d.tickers!.filter((x) => !t.includes(x)), ...t]);
      })
      .catch(() => {});
  }, [isSignedIn]);

  const recordProgress = useCallback((progress: Record<string, unknown>) => {
    void fetch("/api/onboarding/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(progress),
    }).catch(() => {});
  }, []);

  const progressStarted = useRef(false);
  useEffect(() => {
    if (!isSignedIn || !user || progressStarted.current) return;
    progressStarted.current = true;
    const q = new URLSearchParams(window.location.search);
    const add = q.get("add")?.toUpperCase();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
    recordProgress({
      timezone,
      intendedPlan: q.get("plan") ?? undefined,
      intendedTickers: add && /^[A-Z.]{1,6}$/.test(add) ? [add] : [],
      acquisition: readFirstTouch(),
    });
    const analyticsKey = `amm-account-sign-up:${user.id}`;
    if (!localStorage.getItem(analyticsKey)) {
      captureAnalyticsEvent("sign_up", { method: "clerk_account" });
      localStorage.setItem(analyticsKey, "1");
    }
    captureAnalyticsEvent("onboarding_viewed", { has_intended_ticker: Boolean(add) });
  }, [isSignedIn, user, recordProgress]);

  // The blocked add IS the upgrade moment: hold the ticker they wanted.
  const [pendingSym, setPendingSym] = useState<string | null>(null);
  const up = usage ? nextTier(usage.tier) : null;

  // Back from Stripe: the webhook may lag the redirect by a few seconds —
  // poll until the tier lands so the picker opens with the paid cap.
  const awaitingTier = !!upgraded && usage?.tier === "free";
  useEffect(() => {
    if (!awaitingTier) return;
    const t = setInterval(() => window.dispatchEvent(new Event("desk-usage-changed")), 2500);
    return () => clearInterval(t);
  }, [awaitingTier]);

  const choosePaid = useCallback(async (t: Tier, pendingTicker?: string) => {
    if (payingFor) return;
    setPayingFor(t);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: t, returnTo: "onboarding", ...(pendingTicker ? { pendingTicker } : {}) }),
      });
      const j = await res.json();
      if (res.ok && j.url) {
        captureAnalyticsEvent("begin_checkout", {
          currency: "USD",
          value: t === "ultra" ? 399 : 25,
          items: [{ item_id: t, item_name: TIERS[t].label, price: t === "ultra" ? 399 : 25, quantity: 1 }],
        });
        location.assign(j.url);
        return;
      }
      setError(j.error ?? "Couldn't start checkout — try again");
    } catch {
      setError("Network error — try again");
    }
    setPayingFor(null);
  }, [payingFor]);

  // A signed-out buyer returns here after authentication. Start paid checkout
  // once; unpaid access never falls through to the company picker.
  const directPurchaseStarted = useRef(false);
  useEffect(() => {
    if (!isSignedIn || !usage || directPurchaseStarted.current) return;
    if (purchaseIntent !== "pro" && purchaseIntent !== "ultra") return;
    directPurchaseStarted.current = true;
    const timer = window.setTimeout(() => void choosePaid(purchaseIntent), 0);
    return () => window.clearTimeout(timer);
  }, [choosePaid, isSignedIn, purchaseIntent, usage]);

  // Typeahead over every US-listed company (SEC's official map, ~9.3k names).
  // Stays live at the cap when a higher tier exists — picking the stock that
  // doesn't fit is exactly what opens the upgrade card.
  useEffect(() => {
    const q = input.trim();
    const t = setTimeout(() => {
      if (!q || (tickers.length >= cap && !up)) {
        setHits([]);
        return;
      }
      fetch(`/api/tickers/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => j && setHits(j.hits ?? []))
        .catch(() => {});
    }, q && (tickers.length < cap || up) ? 180 : 0);
    return () => clearTimeout(t);
  }, [input, tickers.length, cap, up]);

  async function addTicker(t: string) {
    const sym = t.toUpperCase().trim();
    if (!sym || tickers.includes(sym) || checkingTicker) return;
    setError(null);
    setCoverageNotice(null);
    setCheckingTicker(sym);
    try {
      const response = await fetch(`/api/tickers/support?ticker=${encodeURIComponent(sym)}`, {
        cache: "no-store",
      });
      const result = await response.json() as { supported?: boolean; message?: string };
      if (!response.ok || !result.supported) {
        setInput(sym);
        setHits([]);
        if (response.status === 422) {
          setCoverageNotice(result.message ?? "This stock is outside AMM's current research coverage.");
        } else {
          setError(result.message ?? "We could not verify this stock just now. Please try again shortly.");
        }
        return;
      }
    } catch {
      setError("We could not verify this stock just now. Please try again shortly.");
      return;
    } finally {
      setCheckingTicker(null);
    }
    if (tickers.length >= cap) {
      if (up) {
        setPendingSym(sym);
        setInput("");
        setHits([]);
      }
      return;
    }
    const next = [...tickers, sym];
    setTickers(next);
    recordProgress({
      intendedTickers: next,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    });
    captureAnalyticsEvent("first_ticker_added", { ticker: sym, ticker_count: next.length });
    setInput("");
    setHits([]);
  }

  async function submit() {
    setError(null);
    if (tickers.length === 0) {
      setError("Pick at least one ticker.");
      return;
    }
    setProvisioning(true);

    const stepTimer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, PROVISION_STEPS.length - 1));
    }, 900);

    try {
      const tz =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
      const res = await fetch("/api/desk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers, tz, acquisition: readFirstTouch() }),
      });
      const data = await res.json();
      if (!res.ok) {
        clearInterval(stepTimer);
        setProvisioning(false);
        setStepIndex(0);
        if (data.code === "STOCK_NOT_SUPPORTED") {
          setCoverageNotice(data.error ?? "One selection is outside AMM's current research coverage.");
        } else {
          setError(data.error ?? "Something went wrong. Try again.");
        }
        return;
      }
      if (data.created) {
        captureAnalyticsEvent("desk_created", {
          ticker_count: data.snapshots.length,
          first_ticker: data.snapshots[0]?.symbol ?? "",
          subscription_price_usd: 25,
        });
      }
      for (const s of data.snapshots) {
        setLiveLines((l) => [
          ...l,
          `${s.symbol} — $${s.price?.toFixed(2) ?? "…"} · baseline captured`,
        ]);
        await new Promise((r) => setTimeout(r, 500));
      }

      const additions = Array.isArray(data.additions)
        ? data.additions.filter((symbol: unknown): symbol is string => typeof symbol === "string")
        : [];

      // First-touch provisioning is deliberately limited to the companies
      // added by this save. Existing files are refreshed by the daily fleet
      // run; replaying them here used to launch a full desk concurrently.
      if (additions.length > 0) {
        setLiveLines((l) => [
          ...l,
          `Reading filings and preparing ${additions.length === 1 ? additions[0] : `${additions.length} new companies`} — up to ~2 minutes…`,
        ]);
      }
      const provision = (sym: string) =>
        fetch("/api/desk/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker: sym }),
        })
          .then(async (r) => {
            const j = await r.json().catch(() => null);
            setLiveLines((l) => [
              ...l,
              r.ok && j?.dossier
                ? `${sym} file open — "${String(j.dossier.headline).slice(0, 70)}…"`
                : `${sym} added — research is queued for the next verified run`,
            ]);
          })
          .catch(() => {
            setLiveLines((l) => [...l, `${sym} added — research queued`]);
          });
      if (additions.length > 0) {
        const timeout = new Promise((r) => setTimeout(r, 240_000));
        await Promise.race([
          Promise.allSettled(additions.map(provision)),
          timeout,
        ]);
      }

      setLiveLines((l) => [...l, "AMM Desk is ready. Redirecting…"]);
      await new Promise((r) => setTimeout(r, 700));
      clearInterval(stepTimer);
      beginNavigationFeedback();
      router.push("/desk");
    } catch {
      clearInterval(stepTimer);
      setProvisioning(false);
      setError("Network error. Try again.");
    }
  }

  if (provisioning) {
    return (
      <div className="max-w-lg mx-auto py-20">
        <span className="pp-chip">CLOCKING IN</span>
        <h1 className="pp-disp font-extrabold text-3xl mt-4 mb-8 tracking-tight">
          AMM Desk is getting ready
        </h1>
        <div className="pp-card pp-shadow p-6 space-y-3">
          {PROVISION_STEPS.slice(0, stepIndex + 1).map((s, i) => (
            <div key={s} className="flex items-center gap-3 text-sm">
              <span
                className={i < stepIndex ? "" : "animate-pulse"}
                style={{ color: i < stepIndex ? "var(--pr-up)" : "var(--pr-orange)" }}
              >
                {i < stepIndex ? "✓" : "●"}
              </span>
              <span style={{ color: i < stepIndex ? "var(--pr-faint)" : "var(--pr-ink)" }}>{s}</span>
            </div>
          ))}
          {liveLines.map((l) => (
            <div key={l} className="flex items-center gap-3 pp-mono text-[12.5px]" style={{ color: "var(--pr-blue)" }}>
              <span>→</span>
              <span>{l}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // While Clerk resolves the session (and usage loads for members), hold a
  // quiet beat — never flash the signed-out step at a signed-in member.
  if (!isLoaded || (isSignedIn && !usage)) {
    return (
      <div className="max-w-lg mx-auto py-24">
        <p className="pp-mono text-[11px] uppercase tracking-[0.2em] animate-pulse" style={{ color: "var(--pr-faint)" }}>
          Opening AMM Desk…
        </p>
      </div>
    );
  }

  // Step 1 — sign in before anything else (the desk is keyed to the member).
  if (!isSignedIn) {
    return (
      <div className="max-w-lg mx-auto py-20">
        <span className="pp-chip">STEP 1 OF 2</span>
        <h1 className="pp-disp font-extrabold text-3xl sm:text-4xl mt-4 tracking-tight">
          Start AMM Desk<Tri size="0.34em" />
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
          Sign in to continue to secure checkout. AMM starts immediately with 3 stocks and 30 research questions a month.
        </p>
        <SignInButton
          mode="modal"
          forceRedirectUrl={purchaseIntent === "ultra" ? "/desk/new?purchase=ultra" : "/desk/new?purchase=pro"}
        >
          <button className="pp-btn pp-btn-orange mt-7 w-full py-3.5 text-[16px]">
            Sign in to subscribe →
          </button>
        </SignInButton>
        <p className="mt-3 pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
          $25/month · starts immediately · cancel any time
        </p>
      </div>
    );
  }

  if ((purchaseIntent === "pro" || purchaseIntent === "ultra") && payingFor === purchaseIntent) {
    return (
      <div className="max-w-lg mx-auto py-20">
        <span className="pp-chip">{purchaseIntent === "ultra" ? "AMM ULTRA" : "AMM"}</span>
        <h1 className="pp-disp font-extrabold text-3xl mt-4 tracking-tight">
          Opening secure checkout…
        </h1>
        <p className="mt-3 pp-mono text-[12px] animate-pulse" style={{ color: "var(--pr-dim)" }}>
          {purchaseIntent === "ultra"
            ? "30 stocks · 300 research questions a month · $399/month"
            : "3 stocks · 30 research questions a month · $25/month"}
        </p>
      </div>
    );
  }

  // Back from Stripe, waiting on the webhook to land the tier.
  if (awaitingTier) {
    return (
      <div className="max-w-lg mx-auto py-20">
        <span className="pp-chip">ACTIVATING</span>
        <h1 className="pp-disp font-extrabold text-3xl mt-4 tracking-tight">
          Setting up {upgraded === "ultra" ? "AMM ULTRA" : "AMM PRO"}…
        </h1>
        <p className="mt-3 pp-mono text-[12px] animate-pulse" style={{ color: "var(--pr-dim)" }}>
          Payment confirmed — provisioning your capacity. A few seconds.
        </p>
      </div>
    );
  }

  if (usage?.tier === "free") {
    return (
      <div className="max-w-lg mx-auto py-20">
        <span className="pp-chip">SUBSCRIPTION REQUIRED</span>
        <h1 className="pp-disp font-extrabold text-3xl sm:text-4xl mt-4 tracking-tight">
          Activate AMM Desk<Tri size="0.34em" />
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
          $25/month includes 3 company files, 30 research questions a month, daily research updates, and one Morning Note before the US market opens.
        </p>
        <button
          onClick={() => void choosePaid("pro")}
          disabled={!!payingFor}
          className="pp-btn pp-btn-orange mt-7 w-full py-3.5 text-[16px]"
        >
          {payingFor ? "Opening secure checkout…" : "Subscribe for $25 →"}
        </button>
        {error && <p className="mt-4 text-sm font-medium" style={{ color: "var(--pr-down)" }}>{error}</p>}
        <p className="mt-3 pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
          starts immediately · cancel any time · payments on secure Stripe
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto py-14">
      <span className="pp-chip">STEP 2 OF 2 · 60-SECOND SETUP</span>
      <h1 className="pp-disp font-extrabold text-3xl sm:text-4xl mt-4 tracking-tight">
        Choose stocks for AMM Desk<Tri size="0.34em" />
      </h1>
      <p className="mt-3 text-[14.5px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
        Pick {cap === 1 ? "a company" : `up to ${cap} companies`}. Your paid AMM Desk is active. It builds{" "}
        {cap === 1 ? "the company snapshot" : "their company snapshots"} now,
        follows important developments and trading, and sends your Morning Note.
      </p>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <label className="pp-disp font-bold text-sm">
            Companies ({tickers.length}/{cap})
          </label>
          <TierChip label={tierLabel} />
        </div>
        {tickers.length >= cap && up && !pendingSym && (
          <p className="pp-mono text-[10.5px] mt-1.5" style={{ color: "var(--pr-orange)" }}>
            AMM Desk is full at {cap} file{cap === 1 ? "" : "s"} · pick any stock to add more capacity —{" "}
            {TIERS[up].label} holds {TIERS[up].companies}
          </p>
        )}
        <div className="flex gap-2 mt-2 flex-wrap">
          {tickers.map((t) => (
            <button
              key={t}
              onClick={() => {
                const next = tickers.filter((x) => x !== t);
                setTickers(next);
                recordProgress({ intendedTickers: next });
              }}
              className="pp-mono px-3 py-1.5 rounded-full text-sm font-semibold"
              style={{ background: "var(--pr-blue)", color: "var(--pr-paper)", border: "2px solid var(--pr-ink)" }}
            >
              {t} ✕
            </button>
          ))}
        </div>
        <div className="flex gap-2 mt-3">
          <div className="relative flex-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addTicker(hits[0]?.symbol ?? input);
              }}
              placeholder="Any US stock — ticker or company name"
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none"
              style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}
              maxLength={40}
            />
            {hits.length > 0 && (
              <div
                className="absolute left-0 right-0 z-30 mt-1 rounded-lg overflow-hidden"
                style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)", boxShadow: "4px 4px 0 var(--pr-ink)" }}
              >
                {hits.map((h) => (
                  <button
                    key={h.symbol}
                    onClick={() => void addTicker(h.symbol)}
                    className="w-full flex items-baseline gap-2.5 text-left px-3 py-2 hover:opacity-100"
                    style={{ borderBottom: "1px solid rgba(22,21,15,.1)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#FBF8F1")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span className="pp-mono text-[12.5px] font-bold shrink-0" style={{ color: "var(--pr-blue)" }}>
                      {h.symbol}
                    </span>
                    <span className="text-[12.5px] truncate" style={{ color: "var(--pr-dim)" }}>
                      {h.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => void addTicker(input)}
            disabled={Boolean(checkingTicker)}
            className="pp-btn pp-btn-ghost px-4 py-2 text-sm"
            style={{ background: "var(--pr-card)" }}
          >
            {checkingTicker ? "Checking…" : "Add"}
          </button>
        </div>
        <p className="mt-2 pp-mono text-[10.5px]" style={{ color: "var(--pr-faint)" }}>
          Every selection is checked for complete US filings and dependable market data before it uses a slot.
        </p>
        {coverageNotice && (
          <div
            className="mt-3 rounded-lg px-3.5 py-3"
            style={{ border: "1.5px solid var(--pr-ink)", background: "#FBF8F1" }}
          >
            <p className="pp-mono text-[10px] font-bold tracking-[0.14em]" style={{ color: "var(--pr-orange)" }}>
              RESEARCH COVERAGE
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
              {coverageNotice}
            </p>
          </div>
        )}
        {pendingSym && up && (
          <div
            className="mt-3 rounded-xl p-4"
            style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card, #FFFDF8)", boxShadow: "4px 4px 0 var(--pr-ink)" }}
          >
            <p className="text-[13.5px] font-medium">
              <span className="pp-mono font-bold" style={{ color: "var(--pr-blue)" }}>
                {pendingSym}
              </span>{" "}
              needs another file — AMM Desk currently holds {cap}.
            </p>
            <p className="mt-1 text-[12.5px]" style={{ color: "var(--pr-dim)" }}>
              {TIERS[up].label} holds {TIERS[up].companies} files with {TIERS[up].sittings} research questions a
              month — the same five AI analysts, with research updated daily.
            </p>
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <button
                onClick={() => choosePaid(up, pendingSym)}
                disabled={!!payingFor}
                className="pp-btn pp-btn-orange px-4 py-2.5 text-[14px]"
              >
                {payingFor ? "Opening…" : `Upgrade & add ${pendingSym} — ${TIERS[up].price} →`}
              </button>
              <button
                onClick={() => setPendingSym(null)}
                className="pp-mono text-[11px] underline"
                style={{ color: "var(--pr-faint)" }}
              >
                not now
              </button>
            </div>
          </div>
        )}
        <div className="flex gap-2 mt-3 flex-wrap">
          {SUGGESTED.filter((s) => !tickers.includes(s)).map((s) => (
            <button
              key={s}
              onClick={() => void addTicker(s)}
              disabled={Boolean(checkingTicker)}
              className="pp-mono px-2.5 py-1 rounded-full text-xs"
              style={{ border: "1.5px solid rgba(22,21,15,.4)", color: "var(--pr-dim)", background: "var(--pr-card)" }}
            >
              + {s}
            </button>
          ))}
        </div>
      </div>

      <div
        className="mt-6 rounded-lg px-3 py-3"
        style={{ border: "2px solid var(--pr-ink)", background: "var(--pr-card)" }}
      >
        <p className="pp-disp font-bold text-sm">One market-wide Morning Note</p>
        <p className="pp-mono mt-1 text-[11px]" style={{ color: "var(--pr-faint)" }}>
          Sent around 9:00 AM New York time on US trading days, before the market opens.
        </p>
      </div>

      {error && (
        <p className="mt-4 text-sm font-medium" style={{ color: "var(--pr-down)" }}>
          {error}
        </p>
      )}

      {isSignedIn ? (
        <>
          <button
            onClick={submit}
            className="pp-btn pp-btn-orange mt-7 w-full py-3.5 text-[16px]"
          >
            Start AMM Desk →
          </button>
          <p className="mt-3 pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
            Morning Note goes to {user?.primaryEmailAddress?.emailAddress}
          </p>
        </>
      ) : (
        <>
          <SignInButton mode="modal" forceRedirectUrl="/desk/new">
            <button className="pp-btn pp-btn-orange mt-7 w-full py-3.5 text-[16px]">
              Continue with Google →
            </button>
          </SignInButton>
          <p className="mt-3 pp-mono text-[11px]" style={{ color: "var(--pr-faint)" }}>
            Sign in to save AMM Desk — your Morning Note goes to your Google
            email. $25/month · not financial advice · unsubscribe any time.
          </p>
        </>
      )}
    </div>
  );
}
