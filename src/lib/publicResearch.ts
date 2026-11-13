import { cache } from "react";
import {
  dossierReleaseValidationError,
  getCachedDossier,
  type Dossier,
} from "@/lib/dossier";
import { getDossierHistory } from "@/lib/companyStore";

/**
 * Deliberately small launch universe. These five pages expose the public
 * evidence file for search and trust; AMM's interpretation remains a member
 * product.
 */
export const PUBLIC_RESEARCH_TICKERS = [
  "AMD",
  "META",
  "MSFT",
  "NVDA",
  "TSLA",
] as const;

export function isPublicResearchTicker(ticker: string): boolean {
  return (PUBLIC_RESEARCH_TICKERS as readonly string[]).includes(
    ticker.toUpperCase(),
  );
}

export function isPublishablePublicDossier(value: Dossier | null): value is Dossier {
  return Boolean(
    value &&
      dossierReleaseValidationError(value) === null &&
      value.emailHook.votes.support >= 3,
  );
}

/**
 * Current pointers can temporarily hold an older or failed-gate artifact.
 * Search and public surfaces fall back to the latest fully audited release.
 */
export const getLatestPublishableDossier = cache(
  async (ticker: string): Promise<Dossier | null> => {
    const sym = ticker.toUpperCase();
    const current = await getCachedDossier(sym).catch(() => null);
    if (isPublishablePublicDossier(current)) return current;

    const history = await getDossierHistory<Dossier>(sym, 14).catch(() => []);
    return history.find(isPublishablePublicDossier) ?? null;
  },
);

/** Search snippets must be plain prose, never raw citation markup. */
export function plainResearchText(value: string): string {
  return value
    .replace(/\[(\d+ · \d{4}-\d{2}-\d{2})\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function conciseResearchText(value: string, max = 155): string {
  const clean = plainResearchText(value);
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, Math.max(0, max - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > max * 0.7 ? boundary : clipped.length).trim()}…`;
}

export function stockSeoCopy(
  ticker: string,
  company: string,
  dossier: Dossier | null,
): { title: string; description: string } {
  const sym = ticker.toUpperCase();
  return {
    title: `${sym} Stock Filings, News & Market Evidence`,
    description: conciseResearchText(
      `${company} (${sym}) market data, SEC filings, company-reported metrics, news and original source links${dossier ? `, updated through ${dossier.date}` : ""}.`,
    ),
  };
}
