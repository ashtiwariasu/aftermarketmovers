"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Tri from "@/components/Tri";
import TrackedSourceLink from "@/components/TrackedSourceLink";
import { captureAnalyticsEvent } from "@/lib/analytics";
import type { PublicShort } from "@/lib/publicShorts";

interface YouTubePlayer {
  destroy(): void;
  getCurrentTime(): number;
  getDuration(): number;
  playVideo(): void;
}

interface YouTubePlayerEvent {
  data: number;
  target: YouTubePlayer;
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      host?: string;
      videoId: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady: (event: { target: YouTubePlayer }) => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
  };
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube API requires a browser"));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube API did not initialize"));
    };
    if (!document.getElementById("amm-youtube-iframe-api")) {
      const script = document.createElement("script");
      script.id = "amm-youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube API failed to load"));
      document.head.appendChild(script);
    }
  });
  return youtubeApiPromise;
}

function readableDate(value: string): string {
  return new Date(`${value}T12:00:00.000Z`)
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

function authorityLabel(value: string): string {
  if (value.toLowerCase() === "primary") return "PRIMARY";
  if (value.toLowerCase() === "social") return "SOCIAL";
  return value.replaceAll("_", " ").toUpperCase();
}

export default function StockShortFeature({
  item,
}: {
  item: PublicShort;
}) {
  const reactId = useId();
  const playerId = `stock-short-${reactId.replaceAll(":", "")}`;
  const featureRef = useRef<HTMLElement>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const progressRef = useRef(new Set<number>());
  const impressionSentRef = useRef(false);
  const [playing, setPlaying] = useState(false);

  const baseProperties = useMemo(
    () => ({
      ticker: item.ticker,
      video_id: item.videoId,
      dossier_date: item.dossierDate,
      placement: "public_stock_page",
    }),
    [item.dossierDate, item.ticker, item.videoId],
  );

  useEffect(() => {
    const element = featureRef.current;
    if (!element || impressionSentRef.current) return;
    let timer: number | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          timer = window.setTimeout(() => {
            if (impressionSentRef.current) return;
            impressionSentRef.current = true;
            captureAnalyticsEvent("stock_short_impression", baseProperties);
            observer.disconnect();
          }, 750);
        } else if (timer != null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0.5] },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [baseProperties]);

  useEffect(() => {
    if (!playing || !playerHostRef.current) return;
    let cancelled = false;
    let progressTimer: number | null = null;
    let activePlayer: YouTubePlayer | null = null;

    loadYouTubeApi()
      .then((youtube) => {
        if (cancelled || !playerHostRef.current) return;
        activePlayer = new youtube.Player(playerHostRef.current, {
          host: "https://www.youtube-nocookie.com",
          videoId: item.videoId,
          playerVars: {
            autoplay: 1,
            controls: 1,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: (event) => event.target.playVideo(),
            onStateChange: (event) => {
              if (event.data === youtube.PlayerState.PLAYING && progressTimer == null) {
                progressTimer = window.setInterval(() => {
                  const duration = event.target.getDuration();
                  if (!Number.isFinite(duration) || duration <= 0) return;
                  const ratio = event.target.getCurrentTime() / duration;
                  for (const milestone of [25, 50, 75]) {
                    if (ratio < milestone / 100 || progressRef.current.has(milestone)) continue;
                    progressRef.current.add(milestone);
                    captureAnalyticsEvent("stock_short_progress", {
                      ...baseProperties,
                      percent: milestone,
                    });
                  }
                }, 1_000);
              }
              if (event.data === youtube.PlayerState.ENDED) {
                captureAnalyticsEvent("stock_short_completed", baseProperties);
                if (progressTimer != null) window.clearInterval(progressTimer);
                progressTimer = null;
              }
            },
          },
        });
        playerRef.current = activePlayer;
      })
      .catch(() => {
        // Playback still has a deterministic fallback if the Player API is
        // blocked by privacy software; the initial play event remains valid.
      });

    return () => {
      cancelled = true;
      if (progressTimer != null) window.clearInterval(progressTimer);
      activePlayer?.destroy();
      if (playerRef.current === activePlayer) playerRef.current = null;
    };
  }, [playing, item.videoId, baseProperties]);

  return (
    <section
      ref={featureRef}
      className="pp-card pp-shadow overflow-hidden"
      aria-labelledby={`${playerId}-title`}
    >
      <div className="grid md:grid-cols-[minmax(230px,0.72fr)_minmax(0,1.28fr)]">
        <div
          className="relative min-h-[420px] md:min-h-[510px]"
          style={{ background: "var(--pr-ink)" }}
        >
          {playing ? (
            <div
              id={playerId}
              ref={playerHostRef}
              className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full"
            />
          ) : (
            <button
              type="button"
              className="absolute inset-0 w-full h-full bg-cover bg-center group"
              style={{ backgroundImage: `url("${item.thumbnailUrl}")` }}
              aria-label={`Play the latest ${item.ticker} analysis`}
              onClick={() => {
                captureAnalyticsEvent("stock_short_played", baseProperties);
                setPlaying(true);
              }}
            >
              <span
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(0,0,0,.02) 34%, rgba(0,0,0,.68) 100%)",
                }}
              />
              <span
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center w-[78px] h-[78px] rounded-full transition-transform group-hover:scale-105"
                style={{
                  background: "var(--pr-paper)",
                  border: "2px solid var(--pr-ink)",
                  boxShadow: "5px 5px 0 var(--pr-orange)",
                }}
              >
                <Tri size="20px" />
              </span>
              <span
                className="absolute left-0 right-0 bottom-5 pp-mono text-[10px] tracking-[0.13em] font-bold"
                style={{ color: "var(--pr-paper)" }}
              >
                PLAY · ABOUT 1 MIN
              </span>
            </button>
          )}
        </div>

        <div className="p-6 sm:p-8 flex flex-col">
          <div
            className="flex items-center justify-between gap-4 pb-4"
            style={{ borderBottom: "1.5px solid rgba(22,21,15,.18)" }}
          >
            <p
              className="pp-mono text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--pr-orange)" }}
            >
              Daily AMM Short
            </p>
            <time
              className="pp-mono text-[9px] tracking-[0.12em]"
              dateTime={item.dossierDate}
              style={{ color: "var(--pr-faint)" }}
            >
              {readableDate(item.dossierDate)}
            </time>
          </div>

          <div className="mt-6">
            <div className="flex items-center gap-3 flex-wrap">
              <strong
                className="pp-disp text-3xl"
                style={{ color: "var(--pr-blue)" }}
              >
                {item.ticker}
              </strong>
              {item.signal ? (
                <span className="pp-chip">
                  {item.signal}
                  {item.horizon ? ` · ${item.horizon}` : ""}
                </span>
              ) : null}
            </div>
            <h3
              id={`${playerId}-title`}
              className="pp-disp font-extrabold text-2xl sm:text-3xl leading-tight mt-4"
            >
              {item.title}
            </h3>
            <p
              className="text-[13.5px] leading-relaxed mt-3"
              style={{ color: "var(--pr-dim)" }}
            >
              The public one-minute read from this exact daily file. Full
              reasoning, analyst disagreement and continuing context stay in
              AMM.
            </p>
          </div>

          <div
            className="mt-7 pt-5"
            style={{ borderTop: "1.5px solid rgba(22,21,15,.18)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="pp-mono text-[10px] uppercase tracking-[0.18em]">
                Sources used in this video
              </p>
              <span
                className="pp-mono text-[9px]"
                style={{ color: "var(--pr-faint)" }}
              >
                {item.sources.length} TRACEABLE
              </span>
            </div>
            {item.sources.length ? (
              <ol className="mt-2">
                {item.sources.map((source, index) => (
                  <li
                    key={source.id}
                    className="py-2.5"
                    style={{
                      borderTop:
                        index > 0
                          ? "1px solid rgba(22,21,15,.12)"
                          : undefined,
                    }}
                  >
                    <TrackedSourceLink
                      href={source.url}
                      ticker={item.ticker}
                      section="video_source"
                      publisher={source.publisher}
                      authority={source.authority}
                      sourceId={source.id}
                      videoId={item.videoId}
                      className="block hover:opacity-65"
                    >
                      <span className="block text-[12.5px] leading-snug font-semibold">
                        {source.title}
                      </span>
                      <span
                        className="block pp-mono text-[8.5px] uppercase tracking-[0.09em] mt-1"
                        style={{ color: "var(--pr-faint)" }}
                      >
                        {source.publisher} · {authorityLabel(source.authority)} ·{" "}
                        {source.publishedDate} ↗
                      </span>
                    </TrackedSourceLink>
                  </li>
                ))}
              </ol>
            ) : (
              <p
                className="text-[12.5px] leading-relaxed mt-3"
                style={{ color: "var(--pr-dim)" }}
              >
                This video predates the source-receipt upgrade. Its full source
                file remains available below.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
