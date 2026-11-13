import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import NavAuth from "@/components/NavAuth";
import GetStartedCta from "@/components/GetStartedCta";
import Tri from "@/components/Tri";
import AmmFox from "@/components/AmmFox";
import JsonLd from "@/components/JsonLd";
import LatestShorts from "@/components/LatestShorts";
import { getMovers } from "@/lib/yahoo";
import { listAllDesks } from "@/lib/desk";
import {
  type Dossier,
  type DossierSignalDirection,
} from "@/lib/dossier";
import { getLatestPublishableDossier } from "@/lib/publicResearch";
import { getLatestPublicShorts } from "@/lib/publicShorts";
import { isPublicProductionBuild } from "@/lib/environment";

export const revalidate = 300;

export const metadata: Metadata = {
  title: { absolute: "AMM — AI Stock Research While You Sleep" },
  description:
    "Five frontier AI analysts research the stocks you track and deliver one stress-tested thesis each morning.",
  alternates: { canonical: "https://aftermarketmovers.com/" },
};

// Paper Round palette
const INK = "#16150F";
const PAPER = "#F4F1EA";
const CARD = "#FFFDF8";
const BLUE = "#2B4BF2";
const ORANGE = "#FF4D1F";
const LIME = "#D9F45B";
const SAND = "#EDE9DF";

const disp = "var(--font-bricolage), sans-serif";
const body = "var(--font-space), sans-serif";
const mono = "var(--font-plex-mono), monospace";
const FALLBACK_COVERAGE = [
  "AAPL", "AMD", "AMZN", "GOOGL", "META", "MSFT",
  "NBIS", "NVDA", "PLTR", "SKHY", "TSLA",
];

interface ThesisTapeItem {
  ticker: string;
  line: string;
  direction: DossierSignalDirection;
  generatedAt: number;
}

async function latestThesisTape(): Promise<ThesisTapeItem[]> {
  const desks = await listAllDesks().catch(() => []);
  const watched = [...new Set(
    desks.flatMap((desk) => desk.tickers.map((ticker) => ticker.toUpperCase())),
  )];
  const tickers = watched.length > 0 ? watched : FALLBACK_COVERAGE;
  const dossiers = await Promise.all(tickers.map(getLatestPublishableDossier));
  return dossiers
    .filter((dossier): dossier is Dossier => dossier !== null)
    .map((dossier) => ({
      ticker: dossier.ticker,
      line: dossier.emailHook.subjectPunchline,
      direction: dossier.emailHook.signal.direction,
      generatedAt: dossier.generatedAt,
    }))
    .sort((left, right) =>
      right.generatedAt - left.generatedAt || left.ticker.localeCompare(right.ticker)
    );
}

export default async function Home() {
  // Production keeps its five-minute ISR page. The development image shares
  // live research data, so it must read that data only after a real request —
  // never from an uncredentialed Cloud Build worker.
  if (!isPublicProductionBuild()) await connection();
  const [data, thesisTape, latestShorts] = await Promise.all([
    getMovers(),
    latestThesisTape(),
    getLatestPublicShorts(2),
  ]);
  const hasExt =
    data.afterHours.gainers.length + data.afterHours.losers.length > 0;
  const pool = hasExt
    ? [...data.afterHours.gainers, ...data.afterHours.losers]
    : [...data.regular.gainers, ...data.regular.losers];
  const ranked = [...pool].sort(
    (a, b) =>
      Math.abs((b.extChangePercent ?? b.dayChangePercent) ?? 0) -
      Math.abs((a.extChangePercent ?? a.dayChangePercent) ?? 0)
  );
  const [m1, m2] = ranked;
  const chg = (m: (typeof ranked)[number]) =>
    (m.extChangePercent ?? m.dayChangePercent) ?? 0;
  const fmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  const sess = hasExt ? "AH" : "last session";

  const tickerItems = thesisTape.length > 0
    ? thesisTape
    : [
        ...(m1 ? [{
          ticker: m1.symbol,
          line: fmt(chg(m1)) + " " + sess,
          direction: chg(m1) >= 0 ? "UP" as const : "DOWN" as const,
          generatedAt: data.fetchedAt,
        }] : []),
        ...(m2 ? [{
          ticker: m2.symbol,
          line: fmt(chg(m2)) + " " + sess,
          direction: chg(m2) >= 0 ? "UP" as const : "DOWN" as const,
          generatedAt: data.fetchedAt,
        }] : []),
      ];

  const ticker = tickerItems.flatMap((item, i) => [
    <span key={"t" + i}>
      <strong style={{ color: PAPER }}>{item.ticker}</strong>{" "}
      <strong style={{ color: item.direction === "UP" ? LIME : ORANGE }}>
        {item.direction === "UP" ? "▲" : "▼"}
      </strong>{" "}
      {item.line}
    </span>,
    <span key={"d" + i}>●</span>,
  ]);

  return (
    <div style={{ background: PAPER, color: INK, fontFamily: body }}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              "@id": "https://aftermarketmovers.com/#organization",
              name: "AMM",
              alternateName: "After Market Movers",
              url: "https://aftermarketmovers.com/",
              logo: "https://aftermarketmovers.com/icon.png",
              legalName: "Evolo Pty Ltd",
              description:
                "AI-assisted factual stock research with traceable evidence and independent model review.",
            },
            {
              "@type": "WebSite",
              "@id": "https://aftermarketmovers.com/#website",
              url: "https://aftermarketmovers.com/",
              name: "AMM",
              alternateName: "After Market Movers",
              publisher: { "@id": "https://aftermarketmovers.com/#organization" },
              inLanguage: "en",
            },
          ],
        }}
      />
      <style>{`.pr-cta{transition:transform .12s ease, box-shadow .12s ease}.pr-cta:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 ${INK} !important}`}</style>

      {/* ticker strip */}
      <div style={{ overflow: "hidden", background: INK, color: PAPER, padding: "9px 0", whiteSpace: "nowrap" }}>
        <div
          style={{
            display: "inline-flex",
            gap: 48,
            fontFamily: mono,
            fontSize: 12,
            animation: "tape " + Math.max(40, tickerItems.length * 8) + "s linear infinite",
          }}
        >
          {ticker}
          {ticker}
        </div>
      </div>

      {/* nav */}
      <div style={{ borderBottom: `2px solid ${INK}` }}>
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 28px",
          }}
        >
          <span style={{ fontFamily: disp, fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em" }}>
            AMM<Tri />
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <Link href="/team" style={{ fontSize: 14, fontWeight: 500 }}>
              The team
            </Link>
            <a href="#pricing" style={{ fontSize: 14, fontWeight: 500 }}>
              Pricing
            </a>
            <NavAuth
              signedOutLabel="Sign in"
              className="pr-cta"
              style={{
                fontFamily: disp,
                fontSize: 14,
                fontWeight: 700,
                background: "transparent",
                color: INK,
                padding: "8px 2px",
                borderBottom: `1px solid ${INK}`,
                whiteSpace: "nowrap",
              }}
            />
          </div>
        </div>
      </div>

      {/* hero */}
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "64px 28px 58px",
          display: "flex",
          flexDirection: "column",
          gap: 30,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: disp,
            fontWeight: 800,
            fontSize: "clamp(38px, 6vw, 68px)",
            lineHeight: 1,
            letterSpacing: "-0.035em",
            maxWidth: 1060,
          }}
        >
          AI that researches your stocks{" "}
          <span style={{ color: BLUE }}>while you sleep</span>
          <Tri size="0.34em" />
        </h1>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 40,
            flexWrap: "wrap",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 18,
              lineHeight: 1.55,
              color: "rgba(22,21,15,.72)",
              maxWidth: 560,
            }}
          >
            Five frontier AI analysts read the filings, news and social chatter
            around every company you track — and study how the stock traded.
            They build the thesis, stress-test it, and give you the intelligence
            gold nugget — not another dashboard or report.
          </p>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <GetStartedCta
              className="pr-cta"
              style={{
                fontFamily: disp,
                fontSize: 18,
                fontWeight: 800,
                background: ORANGE,
                color: PAPER,
                padding: "16px 32px",
                borderRadius: 10,
                boxShadow: `4px 4px 0 ${INK}`,
                whiteSpace: "nowrap",
              }}
            >
              Subscribe for $25
            </GetStartedCta>
            <span style={{ fontFamily: mono, fontSize: 12, color: "rgba(22,21,15,.5)" }}>
              $25/month · 3 stocks · cancel any time
            </span>
          </div>
        </div>

      </div>

      <LatestShorts items={latestShorts} />

      {/* pillars */}
      <div style={{ borderTop: `2px solid ${INK}` }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "58px 28px" }}>
          <span
            style={{
              display: "inline-block",
              fontFamily: mono,
              fontSize: 12,
              letterSpacing: "0.1em",
              background: INK,
              color: PAPER,
              padding: "5px 12px",
              borderRadius: 6,
              marginBottom: 32,
              whiteSpace: "nowrap",
            }}
          >
            WHAT AMM DESK DOES
          </span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 20,
            }}
          >
            {[
              [
                "01",
                "It works while you sleep",
                "Nightly sweep of the whole market — filings, earnings, unusual volume. Every find is a worked thesis, never a tip.",
              ],
              [
                "02",
                "It never loses the thread",
                "A living case file per company. Every filing, promise and shock updates it — the memory compounds every quarter.",
              ],
              [
                "03",
                "Your Morning Note. Yours alone.",
                "60 seconds before the open, fully personalised. Quiet night? It tells you nothing needs your attention — honestly.",
              ],
              [
                "04",
                "Ask AMM Desk",
                "Five AI analysts research your question independently, challenge one another and show where they disagree. You get one clear answer with sources.",
              ],
            ].map(([n, h, p]) => (
              <div
                key={n}
                style={{
                  background: CARD,
                  border: `2px solid ${INK}`,
                  borderRadius: 14,
                  padding: "26px 28px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <span style={{ fontFamily: disp, fontWeight: 800, fontSize: 26, color: ORANGE }}>
                  {n}
                </span>
                <h3
                  style={{
                    margin: 0,
                    fontFamily: disp,
                    fontWeight: 800,
                    fontSize: 23,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {h}
                </h3>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: "rgba(22,21,15,.7)" }}>
                  {p}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* pricing */}
      <div id="pricing" style={{ borderTop: `2px solid ${INK}`, background: SAND }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "58px 28px", position: "relative" }}>
          <h2
            style={{
              margin: "0 0 32px",
              maxWidth: 760,
              fontFamily: disp,
              fontWeight: 800,
              fontSize: "clamp(30px, 4.5vw, 44px)",
              letterSpacing: "-0.03em",
            }}
          >
            A whole team for less than $1 a day.
          </h2>
          <div style={{ position: "absolute", right: 44, top: 8 }} className="hidden md:block">
            <AmmFox size={126} />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 20,
              alignItems: "stretch",
              maxWidth: 560,
              margin: "0 auto",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                background: INK,
                color: PAPER,
                border: `2px solid ${INK}`,
                borderRadius: 14,
                padding: 26,
                boxShadow: `5px 5px 0 ${ORANGE}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: mono, fontSize: 12, letterSpacing: "0.1em", color: LIME }}>
                  AMM DESK
                </span>
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 10.5,
                    background: ORANGE,
                    padding: "3px 8px",
                    borderRadius: 4,
                  }}
                >
                  ONE SIMPLE PLAN
                </span>
              </div>
              <span style={{ fontFamily: disp, fontWeight: 800, fontSize: 34 }}>
                $25
                <span style={{ fontSize: 15, opacity: 0.6 }}> /month</span>
              </span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: "rgba(244,241,234,.85)",
                }}
              >
                <span>3 companies on file</span>
                <span>30 research questions a month</span>
                <span>Research updated daily · Morning Note · full research</span>
              </div>
              <GetStartedCta plan="pro"
                style={{
                  marginTop: "auto",
                  textAlign: "center",
                  fontFamily: disp,
                  fontSize: 15,
                  fontWeight: 700,
                  background: LIME,
                  color: INK,
                  padding: "11px 0",
                  borderRadius: 8,
                  whiteSpace: "nowrap",
                }}
              >
                Subscribe for $25
              </GetStartedCta>
            </div>
          </div>
          <p
            style={{
              margin: "18px 0 0",
              fontFamily: mono,
              fontSize: 12,
              letterSpacing: "0.06em",
              color: "rgba(22,21,15,.55)",
            }}
          >
            $25/month for 3 stocks and 30 research questions. Starts immediately;
            change or cancel any time through secure Stripe billing.
          </p>
        </div>
      </div>

      {/* final CTA */}
      <div style={{ borderTop: `2px solid ${INK}`, background: BLUE, color: PAPER }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "64px 28px", textAlign: "center" }}>
          <h2
            style={{
              margin: "0 0 14px",
              fontFamily: disp,
              fontWeight: 800,
              fontSize: "clamp(34px, 5vw, 50px)",
              letterSpacing: "-0.03em",
            }}
          >
            AMM Desk starts working tonight.
          </h2>
          <p style={{ margin: "0 0 26px", fontSize: 17, opacity: 0.85 }}>
            Pick a company. First brief in about a minute.
          </p>
          <GetStartedCta
            className="pr-cta"
            style={{
              display: "inline-flex",
              fontFamily: disp,
              fontSize: 18,
              fontWeight: 800,
              background: PAPER,
              color: INK,
              padding: "16px 34px",
              borderRadius: 10,
              boxShadow: `4px 4px 0 ${INK}`,
              whiteSpace: "nowrap",
            }}
          >
            Subscribe for $25
          </GetStartedCta>
        </div>
      </div>

      {/* footer */}
      <div style={{ background: INK, color: "rgba(244,241,234,.45)" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 28px 26px" }}>
          <p style={{ margin: 0, fontFamily: mono, fontSize: 11, lineHeight: 1.6 }}>
            Factual market research only: evidence, disagreement and history.
            No buy/sell recommendations, no target prices, no personal advice.
            © Evolo Pty Ltd · aftermarketmovers.com ·{" "}
            <Link href="/methodology" style={{ textDecoration: "underline" }}>
              methodology
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
