export const NAVIGATION_FEEDBACK_START = "amm:navigation-feedback:start";

/**
 * Gives programmatic navigation the same immediate feedback as ordinary links.
 * Safe to call during SSR; the event is only emitted in a browser.
 */
export function beginNavigationFeedback() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NAVIGATION_FEEDBACK_START));
}
