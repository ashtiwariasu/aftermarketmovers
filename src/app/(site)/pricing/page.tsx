import type { Metadata } from "next";
import PlanCards from "@/components/PlanCards";
import Tri from "@/components/Tri";

export const metadata: Metadata = {
  title: "Pricing — AMM · After Market Movers",
  description:
    "AMM Desk is $25/month for 3 stocks, 30 research questions, daily research updates, and a Morning Note before the open.",
  alternates: { canonical: "https://aftermarketmovers.com/pricing" },
};

export default function Pricing() {
  return (
    <div className="max-w-3xl mx-auto py-14">
      <span className="pp-chip">PRICING</span>
      <h1 className="pp-disp font-extrabold text-3xl sm:text-4xl mt-4 tracking-tight">
        One AMM Desk. One plan<Tri size="0.34em" />
      </h1>
      <p className="mt-3 text-[14.5px] leading-relaxed max-w-xl" style={{ color: "var(--pr-dim)" }}>
        $25/month gives you 3 stocks, 30 research questions a month, daily
        research updates, and one Morning Note before the US market opens.
        The five AI analysts build a thesis, challenge it, check the numbers
        and sources, and publish only what survives.
      </p>
      <div className="mt-9">
        <PlanCards />
      </div>
    </div>
  );
}
