"use client";

import { useState } from "react";
import Tri from "@/components/Tri";
import { captureAnalyticsEvent } from "@/lib/analytics";
import type { PublicShort } from "@/lib/publicShorts";

const INK = "#16150F";
const CARD = "#FFFDF8";
const BLUE = "#2B4BF2";
const ORANGE = "#FF4D1F";
const LIME = "#D9F45B";

function readableDate(value: string): string {
  return new Date(`${value}T12:00:00.000Z`)
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
}

function ShortPlayer({
  item,
  position,
}: {
  item: PublicShort;
  position: number;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    <article className="amm-short-card">
      <div className="amm-short-frame">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${item.videoId}?autoplay=1&rel=0&playsinline=1`}
            title={`${item.ticker}: ${item.title}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            className="amm-short-poster"
            style={{ backgroundImage: `url("${item.thumbnailUrl}")` }}
            aria-label={`Play ${item.ticker} AMM Short`}
            onClick={() => {
              captureAnalyticsEvent("short_played", {
                ticker: item.ticker,
                video_id: item.videoId,
                dossier_date: item.dossierDate,
                placement: "homepage_latest_shorts",
                position,
              });
              setPlaying(true);
            }}
          >
            <span className="amm-short-shade" />
            <span className="amm-short-index">0{position}</span>
            <span className="amm-short-play">
              <Tri size="19px" />
            </span>
            <span className="amm-short-play-label">PLAY · ABOUT 1 MIN</span>
          </button>
        )}
      </div>
      <div className="amm-short-copy">
        <div className="amm-short-kicker">
          <span>{readableDate(item.dossierDate)}</span>
          <span>{item.companyName}</span>
        </div>
        <div className="amm-short-symbol-row">
          <strong>{item.ticker}</strong>
          {item.signal ? (
            <span>
              {item.signal}
              {item.horizon ? ` · ${item.horizon}` : ""}
            </span>
          ) : null}
        </div>
        <h3>{item.title}</h3>
      </div>
    </article>
  );
}

export default function LatestShorts({ items }: { items: PublicShort[] }) {
  if (!items.length) return null;

  return (
    <section className="amm-shorts-section" aria-labelledby="latest-shorts-title">
      <style>{`
        .amm-shorts-section{border-top:2px solid ${INK};padding:56px 28px 62px}
        .amm-shorts-inner{max-width:1200px;margin:0 auto}
        .amm-shorts-eyebrow{display:flex;align-items:center;gap:10px;font-family:var(--font-plex-mono),monospace;font-size:11px;letter-spacing:.13em;color:${ORANGE};font-weight:700}
        .amm-shorts-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:32px;margin:16px 0 28px}
        .amm-shorts-heading h2{font-family:var(--font-bricolage),sans-serif;font-size:clamp(32px,4.5vw,54px);line-height:.98;letter-spacing:-.035em;margin:0;max-width:690px}
        .amm-shorts-heading p{font-size:16px;line-height:1.5;color:rgba(22,21,15,.64);max-width:360px;margin:0}
        .amm-shorts-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
        .amm-short-card{display:grid;grid-template-columns:minmax(176px,42%) 1fr;background:${CARD};border:2px solid ${INK};border-radius:16px;overflow:hidden;box-shadow:6px 6px 0 ${INK};min-height:400px}
        .amm-short-frame{position:relative;background:${INK};min-height:400px}
        .amm-short-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
        .amm-short-poster{position:absolute;inset:0;width:100%;height:100%;border:0;background-position:center;background-size:cover;cursor:pointer;color:${CARD};padding:0;overflow:hidden}
        .amm-short-poster:focus-visible{outline:4px solid ${LIME};outline-offset:-6px}
        .amm-short-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.04) 25%,rgba(0,0,0,.72) 100%)}
        .amm-short-index{position:absolute;top:16px;left:16px;font-family:var(--font-plex-mono),monospace;font-size:12px;background:${CARD};color:${INK};padding:5px 8px;border:1px solid ${INK};border-radius:5px}
        .amm-short-play{position:absolute;left:50%;top:48%;transform:translate(-50%,-50%);display:grid;place-items:center;width:74px;height:74px;border-radius:50%;background:${CARD};border:2px solid ${INK};box-shadow:4px 4px 0 ${ORANGE};transition:transform .14s ease,box-shadow .14s ease}
        .amm-short-poster:hover .amm-short-play{transform:translate(-50%,-50%) scale(1.06);box-shadow:6px 6px 0 ${ORANGE}}
        .amm-short-play-label{position:absolute;left:0;right:0;bottom:20px;text-align:center;font-family:var(--font-plex-mono),monospace;font-size:10px;letter-spacing:.12em;font-weight:700}
        .amm-short-copy{padding:24px 22px;display:flex;flex-direction:column}
        .amm-short-kicker{display:flex;justify-content:space-between;gap:10px;padding-bottom:15px;border-bottom:1px solid rgba(22,21,15,.28);font-family:var(--font-plex-mono),monospace;font-size:10px;letter-spacing:.09em;color:rgba(22,21,15,.58);text-transform:uppercase}
        .amm-short-symbol-row{display:flex;flex-direction:column;gap:8px;margin-top:auto;padding-top:24px}
        .amm-short-symbol-row strong{font-family:var(--font-bricolage),sans-serif;color:${BLUE};font-size:36px;line-height:1}
        .amm-short-symbol-row span{font-family:var(--font-plex-mono),monospace;color:${ORANGE};font-size:10px;line-height:1.35;letter-spacing:.08em;font-weight:700}
        .amm-short-copy h3{font-family:var(--font-bricolage),sans-serif;font-size:22px;line-height:1.08;letter-spacing:-.025em;margin:16px 0 0}
        @media(max-width:900px){
          .amm-shorts-heading{align-items:flex-start;flex-direction:column;gap:12px}
          .amm-shorts-grid{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 6px 10px 0}
          .amm-short-card{flex:0 0:min(88vw,570px);scroll-snap-align:start}
        }
        @media(max-width:560px){
          .amm-shorts-section{padding:42px 18px 50px}
          .amm-short-card{grid-template-columns:44% 1fr;min-height:340px}
          .amm-short-frame{min-height:340px}
          .amm-short-copy{padding:18px 15px}
          .amm-short-symbol-row strong{font-size:29px}
          .amm-short-copy h3{font-size:18px}
          .amm-short-kicker{flex-direction:column}
        }
      `}</style>
      <div className="amm-shorts-inner">
        <div className="amm-shorts-eyebrow">
          <Tri size="11px" />
          LATEST AMM SHORTS · UPDATED AFTER EACH DAILY RUN
        </div>
        <div className="amm-shorts-heading">
          <h2 id="latest-shorts-title">The market moved. Here’s what matters.</h2>
          <p>
            {items.length > 1
              ? "Two evidence-checked stock theses, explained in about a minute each."
              : "The latest evidence-checked stock thesis, explained in about a minute."}
          </p>
        </div>
        <div className="amm-shorts-grid">
          {items.map((item, index) => (
            <ShortPlayer
              key={item.videoId}
              item={item}
              position={index + 1}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
