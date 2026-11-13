"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  beginNavigationFeedback,
  NAVIGATION_FEEDBACK_START,
} from "@/lib/navigationFeedback";
import styles from "./RouteTransitionLoader.module.css";

const SHOW_DELAY_MS = 90;
const MIN_VISIBLE_MS = 260;
const FAILSAFE_MS = 12_000;

function isInternalDestination(anchor: HTMLAnchorElement) {
  if (
    anchor.target === "_blank" ||
    anchor.hasAttribute("download") ||
    anchor.dataset.noLoader !== undefined
  ) {
    return false;
  }

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return false;

  const currentRoute = `${window.location.pathname}${window.location.search}`;
  const destinationRoute = `${destination.pathname}${destination.search}`;
  return destinationRoute !== currentRoute;
}

export function BrandLoaderVisual() {
  return (
    <div className={styles.card}>
      <svg
        className={styles.mark}
        viewBox="0 0 100 92"
        aria-hidden
      >
        <polygon
          className={styles.markFill}
          points="50,4 96,88 4,88"
        />
        <polygon
          className={styles.markEdge}
          pathLength="1"
          points="50,4 96,88 4,88"
        />
        <polygon
          className={styles.markTrace}
          pathLength="1"
          points="50,4 96,88 4,88"
        />
      </svg>
      <p>OPENING</p>
    </div>
  );
}

export default function RouteTransitionLoader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const route = `${pathname}?${searchParams.toString()}`;
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const visibleAt = useRef(0);
  const previousRoute = useRef(route);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor && isInternalDestination(anchor)) beginNavigationFeedback();
    }

    function onSubmit(event: SubmitEvent) {
      if (event.defaultPrevented) return;
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const destination = new URL(form.action || window.location.href);
      if (destination.origin === window.location.origin) beginNavigationFeedback();
    }

    function onStart() {
      setPending(true);
    }

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("popstate", beginNavigationFeedback);
    window.addEventListener(NAVIGATION_FEEDBACK_START, onStart);

    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("popstate", beginNavigationFeedback);
      window.removeEventListener(NAVIGATION_FEEDBACK_START, onStart);
    };
  }, []);

  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    setPending(false);
  }, [route]);

  useEffect(() => {
    if (!pending) {
      if (!visible) return;
      const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - visibleAt.current));
      const hide = window.setTimeout(() => setVisible(false), remaining);
      return () => window.clearTimeout(hide);
    }

    const show = window.setTimeout(() => {
      visibleAt.current = Date.now();
      setVisible(true);
    }, SHOW_DELAY_MS);
    const failsafe = window.setTimeout(() => setPending(false), FAILSAFE_MS);

    return () => {
      window.clearTimeout(show);
      window.clearTimeout(failsafe);
    };
  }, [pending, visible]);

  if (!visible) return null;

  return (
    <div className={styles.overlay} role="status" aria-live="polite" aria-label="Opening page">
      <BrandLoaderVisual />
    </div>
  );
}
