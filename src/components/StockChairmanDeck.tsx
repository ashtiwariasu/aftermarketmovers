"use client";

import { useEffect, useMemo, useState } from "react";
import Md from "@/components/Md";
import type { StockChairmanRun } from "@/lib/stockChairmanDeck";
import styles from "./StockChairmanDeck.module.css";

interface Props {
  ticker: string;
  runs: StockChairmanRun[];
}

function dateParts(iso: string): { day: string; date: string } {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { day: "RUN", date: iso };
  return {
    day: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(parsed).toUpperCase(),
    date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(parsed).toUpperCase(),
  };
}

export default function StockChairmanDeck({ ticker, runs }: Props) {
  const ordered = useMemo(
    () => [...runs].sort((a, b) => b.date.localeCompare(a.date) || b.generatedAt - a.generatedAt),
    [runs],
  );
  const [runDate, setRunDate] = useState(ordered[0]?.date ?? "");
  const [cardIndex, setCardIndex] = useState(0);
  const run = ordered.find((item) => item.date === runDate) ?? ordered[0];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!run || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setCardIndex((current) => Math.min(run.cards.length - 1, current + 1));
      }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setCardIndex((current) => Math.max(0, current - 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);

  if (!run) {
    return (
      <section className={styles.shell}>
        <div className={styles.empty}>
          <p className="pp-mono text-[10px] tracking-[0.16em]">NO AMM DESK RESEARCH YET</p>
          <p className="mt-2 text-[14px]" style={{ color: "var(--pr-dim)" }}>
            The latest run did not produce research that passed every check.
          </p>
        </div>
      </section>
    );
  }

  const card = run.cards[Math.min(cardIndex, run.cards.length - 1)];
  const otherCards = run.cards.filter((_, index) => index !== cardIndex);
  const publicStrength = run.signal.strength === "STRONG" ? "STRONG" : "GENTLE";
  const signal = `${run.signal.direction} · ${publicStrength} · ${run.signal.minSessions}–${run.signal.maxSessions} SESSIONS · ${run.signal.support}/5`;

  return (
    <section className={styles.shell} aria-label={`${ticker} AMM Desk research`}>
      <div className={styles.runbar}>
        <div className={styles.dates} aria-label="Daily research runs">
          {ordered.slice(0, 7).reverse().map((item) => {
            const parts = dateParts(item.date);
            const active = item.date === run.date;
            return (
              <button
                key={item.date}
                type="button"
                className={`${styles.date} ${active ? styles.dateActive : ""}`}
                onClick={() => {
                  setRunDate(item.date);
                  setCardIndex(0);
                }}
                aria-current={active ? "date" : undefined}
              >
                <span className={styles.dateDay}>{parts.day}</span>
                <span className={styles.dateValue}>{parts.date}</span>
              </button>
            );
          })}
        </div>
        <div className={styles.controls}>
          <span className={styles.counter} aria-live="polite">
            {ticker} · {cardIndex + 1} OF {run.cards.length}
          </span>
          <button
            type="button"
            className={styles.nav}
            disabled={cardIndex === 0}
            onClick={() => setCardIndex((current) => Math.max(0, current - 1))}
            aria-label="Previous research card"
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.nav}
            disabled={cardIndex === run.cards.length - 1}
            onClick={() => setCardIndex((current) => Math.min(run.cards.length - 1, current + 1))}
            aria-label="Next research card"
          >
            ↓
          </button>
        </div>
      </div>

      <div className={styles.deck}>
        <div className={styles.ghost} aria-hidden />
        <div className={styles.ghost} aria-hidden />
        <article className={styles.card}>
          <div className={styles.rail}>
            <span className={styles.cardNumber}>{String(cardIndex + 1).padStart(2, "0")}</span>
          </div>
          <div className={styles.content}>
            <div className={styles.meta}>
              <span className={styles.cardLabel}>{card.label}</span>
              <span className={styles.signal}>{signal}</span>
            </div>
            <div className={styles.title} role="heading" aria-level={2}>
              <Md text={card.title} />
            </div>
            <div className={styles.body} tabIndex={0} aria-label={`${card.label} content`}>
              <Md text={card.markdown} />
            </div>
          </div>
        </article>

        <div className={styles.closedCards}>
          {otherCards.slice(0, 3).map((item) => {
            const index = run.cards.findIndex((candidate) => candidate.id === item.id);
            return (
              <button key={item.id} type="button" className={styles.closed} onClick={() => setCardIndex(index)}>
                <span className={styles.closedIndex}>{String(index + 1).padStart(2, "0")}</span>
                <span className={styles.closedLabel}>{item.label}</span>
                <span className={styles.closedTitle}>{item.title}</span>
                <span className={styles.closedArrow}>⌄</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
