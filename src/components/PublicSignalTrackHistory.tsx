"use client";

import { useMemo, useState } from "react";
import PublicAmmSignalTrack from "@/components/PublicAmmSignalTrack";
import type { PublicSignalTrackView } from "@/lib/signalTrack";
import styles from "./PublicSignalTrackHistory.module.css";

export interface PublicSignalTrackRun {
  date: string;
  view: PublicSignalTrackView;
}

function dateParts(iso: string): { day: string; date: string } {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { day: "RUN", date: iso };
  return {
    day: new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(parsed).toUpperCase(),
    date: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(parsed).toUpperCase(),
  };
}

export default function PublicSignalTrackHistory({
  ticker,
  runs,
}: {
  ticker: string;
  runs: PublicSignalTrackRun[];
}) {
  const ordered = useMemo(
    () => [...runs].sort((left, right) => right.date.localeCompare(left.date)),
    [runs],
  );
  const [selectedDate, setSelectedDate] = useState(ordered[0]?.date ?? "");
  const selected =
    ordered.find((run) => run.date === selectedDate) ?? ordered[0];

  if (!selected) return null;

  return (
    <section
      className={styles.shell}
      aria-label={`${ticker} published signal history`}
    >
      <div className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>PUBLIC SIGNAL RECORD</p>
          <p className={styles.instruction}>
            Choose a published date to compare AMM&apos;s read with subsequent
            market closes.
          </p>
        </div>
        <div className={styles.dates} aria-label="Published signal dates">
          {ordered.slice(0, 7).reverse().map((run) => {
            const parts = dateParts(run.date);
            const active = run.date === selected.date;
            return (
              <button
                key={run.date}
                type="button"
                className={`${styles.date} ${active ? styles.active : ""}`}
                onClick={() => setSelectedDate(run.date)}
                aria-current={active ? "date" : undefined}
              >
                <span>{parts.day}</span>
                <strong>{parts.date}</strong>
              </button>
            );
          })}
        </div>
      </div>
      <PublicAmmSignalTrack view={selected.view} />
    </section>
  );
}
