import Tri from "@/components/Tri";
import type { Metadata } from "next";
import Link from "next/link";
import { COUNCIL_PAGES } from "@/lib/council";

export const metadata: Metadata = {
  title: "AMM — The AI Team That Never Sleeps",
  description:
    "Meet AMM Desk: five AI analysts that track every important development around your stocks and write a clear Morning Note — with every claim kept on the record.",
  alternates: { canonical: "https://aftermarketmovers.com/team" },
};

export default function Team() {
  const googl = COUNCIL_PAGES.GOOGL;
  return (
    <div className="max-w-[900px] mx-auto">
      {/* Hero */}
      <section className="pt-16 pb-12 text-center">
        <span className="pp-chip">THE TEAM THAT NEVER SLEEPS</span>
        <h1 className="pp-disp font-extrabold text-5xl sm:text-7xl mt-6 leading-[0.98] tracking-tight">
          <span>A</span>
          <span style={{ opacity: 0.35, fontWeight: 700 }}>fter</span>
          <span>M</span>
          <span style={{ opacity: 0.35, fontWeight: 700 }}>arket</span>
          <span>M</span>
          <span style={{ opacity: 0.35, fontWeight: 700 }}>overs</span>
          <Tri size="0.55em" />
        </h1>
        <p className="mt-6 text-lg leading-relaxed max-w-xl mx-auto" style={{ color: "var(--pr-dim)" }}>
          Important company news can arrive while you are working or asleep.
          AMM Desk keeps following the companies you care about, then explains
          what changed and why it matters.{" "}
          <strong style={{ color: "var(--pr-ink)" }}>AMM Desk is yours.</strong>
        </p>
        <div className="mt-8">
          <Link href="/desk/new?purchase=pro" className="pp-btn pp-btn-orange text-[17px] px-8 py-4">
            Subscribe for $25
          </Link>
          <p className="pp-mono text-[11.5px] mt-3" style={{ color: "var(--pr-faint)" }}>
            $25/month · 3 stocks · cancel any time
          </p>
        </div>
      </section>

      {/* The five seats */}
      <section className="py-12" style={{ borderTop: "2px solid var(--pr-ink)" }}>
        <span className="pp-chip">FIVE AI ANALYSTS, ONE AMM DESK</span>
        <div className="mt-8 grid sm:grid-cols-2 gap-5">
          {[
            ["The business analyst", "How the company makes money, how durable it is, and whether the story is real."],
            ["The numbers analyst", "Cash, profit and new shares — do the numbers hold together?"],
            ["The industry analyst", "Competitors and industry trends — is this about the company or the wider market?"],
            ["The expectations analyst", "What investors already expect — and what would genuinely surprise them?"],
            ["The skeptic", "Looks for the strongest evidence that could prove the thesis wrong."],
          ].map(([h, p], i) => (
            <div
              key={h}
              className="pp-card p-6"
              style={i === 4 ? { background: "var(--pr-blue)", color: "var(--pr-paper)" } : undefined}
            >
              <span
                className="pp-disp font-extrabold text-[22px]"
                style={{ color: i === 4 ? "var(--pr-lime)" : "var(--pr-orange)" }}
              >
                0{i + 1}
              </span>
              <h3 className="pp-disp font-extrabold text-xl mt-1">{h}</h3>
              <p
                className="mt-2 text-[14px] leading-relaxed"
                style={{ color: i === 4 ? "rgba(244,241,234,.85)" : "var(--pr-dim)" }}
              >
                {p}
              </p>
            </div>
          ))}
          <div className="pp-card pp-shadow p-6">
            <span className="pp-disp font-extrabold text-[22px]" style={{ color: "var(--pr-blue)" }}>
              +1
            </span>
            <h3 className="pp-disp font-extrabold text-xl mt-1">AMM Desk</h3>
            <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--pr-dim)" }}>
              Runs the shift, weighs the debate, writes your note. When the
              team splits 3–2, it says so — and shows you the dissent.
            </p>
          </div>
        </div>
      </section>

      {/* Receipts */}
      <section className="py-12" style={{ borderTop: "2px solid var(--pr-ink)" }}>
        <span className="pp-chip">EVERY CALL ON THE RECORD</span>
        <div className="mt-8 pp-card pp-shadow p-7" style={{ transform: "rotate(-0.4deg)" }}>
          <p className="text-[15.5px] leading-relaxed">
            Before each earnings event, the team locks its claims —
            timestamped, public, probabilities shown. The morning after,
            they&apos;re scored. Right or wrong.{" "}
            <strong>Nothing gets deleted.</strong>
          </p>
          <p className="mt-4 pp-mono text-[12px]" style={{ color: "var(--pr-dim)" }}>
            Next scoring: Alphabet Q2 — {googl.claims.length} claims recorded ·
            scored Jul 23, 6:30am AEST
          </p>
          <div className="mt-5">
            <Link href="/stock/googl" className="pp-btn pp-btn-ghost text-[14px] px-5 py-2.5">
              See the GOOGL claims →
            </Link>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-14 text-center" style={{ borderTop: "2px solid var(--pr-ink)" }}>
        <h2 className="pp-disp font-extrabold text-4xl sm:text-5xl tracking-tight">
          AMM Desk starts working tonight.
        </h2>
        <p className="mt-3 text-[16px]" style={{ color: "var(--pr-dim)" }}>
          Pick a company. First brief in about a minute.
        </p>
        <div className="mt-6">
          <Link href="/desk/new?purchase=pro" className="pp-btn pp-btn-orange text-[17px] px-8 py-4">
            Subscribe for $25
          </Link>
        </div>
        <p className="pp-mono text-[10.5px] mt-6 max-w-md mx-auto" style={{ color: "var(--pr-faint)" }}>
          A research team, not an adviser. Factual market data, evidence and
          history — never buy/sell recommendations.
        </p>
      </section>
    </div>
  );
}
