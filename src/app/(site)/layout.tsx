import Link from "next/link";
import Tri from "@/components/Tri";
import NavAuth from "@/components/NavAuth";
import GetStartedCta from "@/components/GetStartedCta";
import { SessionBadge } from "@/components/ShiftClock";

export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="pp flex-1 flex flex-col">
      <header
        className="sticky top-0 z-40"
        style={{
          borderBottom: "2px solid var(--pr-ink)",
          background: "rgba(244,241,234,0.94)",
          backdropFilter: "blur(8px)",
        }}
      >
        <nav className="mx-auto max-w-[1200px] px-7 py-4 flex items-center gap-6 text-sm">
          <Link href="/" className="pp-disp font-extrabold text-[19px]">
            AMM<Tri />
          </Link>
          <div className="hidden md:flex items-center gap-5 font-medium">
            <Link href="/team" className="hover:opacity-70" style={{ color: "var(--pr-blue)" }}>
              The team
            </Link>
            <Link href="/pricing" className="hover:opacity-70">
              Pricing
            </Link>
            <Link href="/methodology" className="hover:opacity-70">
              Methodology
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <SessionBadge />
            <NavAuth className="pp-btn pp-btn-blue text-[13.5px] px-4 py-2" />
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-[1200px] px-7 w-full flex-1">{children}</main>
      <footer className="mt-20" style={{ background: "var(--pr-ink)", color: "rgba(244,241,234,.6)" }}>
        <div className="mx-auto max-w-[1200px] px-7 py-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div>
              <p className="pp-disp font-extrabold text-[16px]" style={{ color: "var(--pr-paper)" }}>
                <span>A</span>
                <span style={{ opacity: 0.45, fontWeight: 600 }}>fter</span>
                <span>M</span>
                <span style={{ opacity: 0.45, fontWeight: 600 }}>arket</span>
                <span>M</span>
                <span style={{ opacity: 0.45, fontWeight: 600 }}>overs</span>
                <Tri size="0.45em" />
              </p>
              <p className="mt-3 pp-mono text-[11px] leading-relaxed">
                AMM — the team that never sleeps.
                <br />
                Markets close. AMM Desk doesn&apos;t.
              </p>
            </div>
            <div>
              <p className="pp-mono text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: "var(--pr-lime)" }}>
                Live
              </p>
              <ul className="space-y-2 text-[13px]">
                <li><Link href="/pricing" className="hover:opacity-80">Pricing</Link></li>
                <li><GetStartedCta className="hover:opacity-80">Subscribe · $25</GetStartedCta></li>
              </ul>
            </div>
            <div>
              <p className="pp-mono text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: "var(--pr-lime)" }}>
                Case files
              </p>
              <ul className="space-y-2 text-[13px]">
                <li><Link href="/stock/amd" className="hover:opacity-80">AMD · AMD</Link></li>
                <li><Link href="/stock/meta" className="hover:opacity-80">Meta · META</Link></li>
                <li><Link href="/stock/msft" className="hover:opacity-80">Microsoft · MSFT</Link></li>
                <li><Link href="/stock/nvda" className="hover:opacity-80">NVIDIA · NVDA</Link></li>
                <li><Link href="/stock/tsla" className="hover:opacity-80">Tesla · TSLA</Link></li>
              </ul>
            </div>
            <div>
              <p className="pp-mono text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: "var(--pr-lime)" }}>
                Company
              </p>
              <ul className="space-y-2 text-[13px]">
                <li><Link href="/team" className="hover:opacity-80">The team</Link></li>
                <li><Link href="/methodology" className="hover:opacity-80">Methodology</Link></li>
                <li><Link href="/methodology" className="hover:opacity-80">How it works</Link></li>
                <li><a href="mailto:hello@aftermarketmovers.com" className="hover:opacity-80">Contact</a></li>
              </ul>
            </div>
          </div>
          <div
            className="mt-10 pt-6 pp-mono text-[10.5px] leading-relaxed"
            style={{ borderTop: "1px solid rgba(244,241,234,.15)" }}
          >
            <p>
              Factual market research only: evidence, disagreement and history.
              No buy/sell recommendations, no target prices, no personal
              advice. Consider a licensed adviser before investment decisions.
            </p>
            <p className="mt-2">© {new Date().getFullYear()} Evolo Pty Ltd · aftermarketmovers.com</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
