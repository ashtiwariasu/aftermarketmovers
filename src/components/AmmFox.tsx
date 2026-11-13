"use client";

/**
 * AMM the fox — the mascot, alive. The artwork is a raster (Ash's exact
 * design), so the life comes from whole-character motion plus a measured
 * blink overlay: two fox-blue lids sit exactly over the eyes (positions
 * sampled from the pixels) and appear for ~90ms every few seconds.
 * Idle: a slow breath-bob with a grounded shadow that tracks it, and an
 * occasional curious tilt. Hover: a happy hop. Reduced motion: perfectly still.
 */

const FOX_BLUE = "#0564E3"; // sampled from the artwork

export default function AmmFox({ size = 160, className = "" }: { size?: number; className?: string }) {
  return (
    <div className={`amm-fox ${className}`} style={{ width: size }} aria-hidden>
      <style>{`
        .amm-fox { display: inline-block; }
        .amm-fox-body { position: relative; animation: ammFoxIdle 5.6s ease-in-out infinite; transform-origin: 50% 92%; will-change: transform; }
        .amm-fox:hover .amm-fox-body { animation: ammFoxHop .65s ease-in-out; }
        .amm-fox-lid { position: absolute; width: 9%; height: 8%; border-radius: 50%; background: ${FOX_BLUE}; opacity: 0; transform: translate(-50%, -50%); animation: ammFoxBlink 4.7s infinite; }
        .amm-fox-shadow { display: block; margin: -2% auto 0; width: 62%; height: 7px; border-radius: 50%; background: rgba(22,21,15,.18); animation: ammFoxShadow 5.6s ease-in-out infinite; }
        @keyframes ammFoxIdle {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-2.5%) rotate(0deg); }
          50% { transform: translateY(0) rotate(0deg); }
          70% { transform: translateY(-1%) rotate(-2.2deg); }
          82% { transform: translateY(-1%) rotate(1.4deg); }
          92% { transform: translateY(0) rotate(0deg); }
        }
        @keyframes ammFoxShadow {
          0%, 100% { transform: scaleX(1); opacity: .8; }
          25% { transform: scaleX(.9); opacity: .55; }
          50% { transform: scaleX(1); opacity: .8; }
          70%, 82% { transform: scaleX(.94); opacity: .65; }
        }
        @keyframes ammFoxBlink {
          0%, 93.5% { opacity: 0; }
          94.5%, 96.5% { opacity: 1; }
          97.5%, 100% { opacity: 0; }
        }
        @keyframes ammFoxHop {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          35% { transform: translateY(-9%) rotate(-3deg) scale(1.02); }
          65% { transform: translateY(-4%) rotate(2deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .amm-fox-body, .amm-fox-shadow, .amm-fox-lid { animation: none !important; }
          .amm-fox-lid { opacity: 0 !important; }
        }
      `}</style>
      <div className="amm-fox-body">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/amm-fox.png" alt="" width={size} height={size} style={{ display: "block", width: "100%", height: "auto" }} />
        <span className="amm-fox-lid" style={{ left: "40.2%", top: "48.4%" }} />
        <span className="amm-fox-lid" style={{ left: "60.0%", top: "48.1%" }} />
      </div>
      <span className="amm-fox-shadow" />
    </div>
  );
}
