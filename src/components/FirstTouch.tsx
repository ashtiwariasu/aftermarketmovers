"use client";

import { useEffect } from "react";

const KEY = "amm-first-touch";
const FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "gclid",
  "fbclid",
] as const;

/**
 * First-touch acquisition capture. Runs on every page mount, writes ONCE:
 * the first visit that carries campaign params (or an external referrer)
 * wins, and later visits never overwrite it. Read at desk creation.
 */
export default function FirstTouch() {
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) return;
      const params = new URLSearchParams(window.location.search);
      const touch: Record<string, string> = {};
      for (const f of FIELDS) {
        const v = params.get(f);
        if (v) touch[f] = v.slice(0, 200);
      }
      const referrer = document.referrer;
      if (referrer && !referrer.includes(window.location.hostname)) {
        touch.referrer = referrer.slice(0, 300);
      }
      if (Object.keys(touch).length === 0) return;
      touch.at = String(Date.now());
      touch.landing = (window.location.pathname + window.location.search).slice(0, 300);
      localStorage.setItem(KEY, JSON.stringify(touch));
    } catch {
      // storage unavailable (private mode) — attribution is best-effort
    }
  }, []);
  return null;
}

/** Read the stored first touch for inclusion in the desk-create call. */
export function readFirstTouch(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
