import type { ShortPublicationRecord } from "./shortPublication";

export type DailyShortRecoveryReason =
  | "run-complete"
  | "publication-pair-complete"
  | "primary-readiness-active"
  | "publication-work-active"
  | "fresh-selection-active"
  | "recovery-required";

export interface DailyShortRecoveryDecision {
  action: "skip" | "run";
  reason: DailyShortRecoveryReason;
}

export function dailyShortRecoveryDecision(input: {
  runStatus?: string;
  resultCount?: number;
  selectedCount?: number;
  selectionCreatedAt?: number;
  readinessDeadlineAt?: number;
  publications?: ShortPublicationRecord[];
  requiredCount: number;
  now?: number;
}): DailyShortRecoveryDecision {
  const now = input.now ?? Date.now();
  const runStatus = String(input.runStatus ?? "");
  const publications = input.publications ?? [];
  const completedPublications = publications.filter((record) =>
    ["scheduled", "published"].includes(String(record?.status ?? "")));

  if (
    ["scheduled", "published"].includes(runStatus) &&
    Number(input.resultCount ?? 0) >= input.requiredCount
  ) {
    return { action: "skip", reason: "run-complete" };
  }
  if (completedPublications.length >= input.requiredCount) {
    return { action: "skip", reason: "publication-pair-complete" };
  }

  // A failed primary attempt is recoverable even if its original readiness
  // deadline has not elapsed. Other states with a future deadline belong to
  // the still-running 05:00 execution and must not be raced by recovery.
  if (
    runStatus !== "failed" &&
    Number(input.readinessDeadlineAt ?? 0) > now
  ) {
    return { action: "skip", reason: "primary-readiness-active" };
  }

  const activePublication = publications.some((record) =>
    ["processing", "rendered", "uploading"].includes(String(record?.status ?? "")) &&
    Number(record?.leaseExpiresAt ?? 0) > now);
  if (activePublication) {
    return { action: "skip", reason: "publication-work-active" };
  }

  // Close the very small transaction gap between freezing the pair and
  // claiming its publication records.
  if (
    runStatus === "selected" &&
    Number(input.selectedCount ?? 0) === input.requiredCount &&
    Number(input.selectionCreatedAt ?? 0) > now - 5 * 60_000
  ) {
    return { action: "skip", reason: "fresh-selection-active" };
  }

  return { action: "run", reason: "recovery-required" };
}
