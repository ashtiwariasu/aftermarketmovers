import Link from "next/link";
import AmmFox from "@/components/AmmFox";

const INK = "#16150F";
const PAPER = "#F4F1EA";
const ORANGE = "#FF4D1F";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: PAPER,
        color: INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 28,
        gap: 18,
      }}
    >
      <AmmFox size={190} />
      <h1 style={{ margin: 0, fontWeight: 800, fontSize: "clamp(28px, 5vw, 44px)", letterSpacing: "-0.03em" }}>
        The fox lost this page.
      </h1>
      <p style={{ margin: 0, fontSize: 15, opacity: 0.65, maxWidth: 420, lineHeight: 1.55 }}>
        It happens on the night shift. Everything the Desk actually filed is
        still exactly where it should be.
      </p>
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <Link
          href="/"
          style={{
            fontWeight: 700,
            background: ORANGE,
            color: PAPER,
            padding: "12px 26px",
            borderRadius: 9,
            border: `2px solid ${INK}`,
            boxShadow: `3px 3px 0 ${INK}`,
          }}
        >
          Back to AMM →
        </Link>
        <Link
          href="/desk"
          style={{
            fontWeight: 700,
            padding: "12px 26px",
            borderRadius: 9,
            border: `2px solid ${INK}`,
          }}
        >
          AMM Desk
        </Link>
      </div>
    </div>
  );
}
