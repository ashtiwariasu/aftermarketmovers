import type {
  ShortEpisodeDraft,
  ShortDraftBeat,
  ShortDraftClaim,
} from "@/lib/shortEpisode";

const BEAT_NAMES = [
  "hook",
  "change",
  "thesis",
  "evidence",
  "council",
  "close",
] as const satisfies ReadonlyArray<keyof ShortEpisodeDraft["beats"]>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneClaim(claim: ShortDraftClaim): ShortDraftClaim {
  return {
    ...claim,
    support: claim.support.map((support) => ({ ...support })),
  };
}

function cloneBeat(beat: ShortDraftBeat): ShortDraftBeat {
  return { ...beat, claimIds: [...beat.claimIds] };
}

/**
 * Applies a model-proposed entailment repair while enforcing the evidence lock.
 *
 * The repair may only:
 * - reword statements explicitly rejected by the independent auditor; and
 * - reword beats that cite at least one explicitly rejected claim.
 *
 * It cannot add/remove/reorder claims, change a support quote/source binding,
 * change any beat's claim bindings, touch an accepted claim/beat, or alter the
 * deterministic hook and close. The normal deterministic draft validator and
 * independent entailment auditor still run after this lock.
 */
export function applyEvidenceLockedShortRepair(
  original: ShortEpisodeDraft,
  proposed: ShortEpisodeDraft,
  unsupportedClaimIds: readonly string[],
): ShortEpisodeDraft {
  if (proposed.schema !== original.schema) {
    throw new Error("repair changed the draft schema");
  }
  if (proposed.claims.length !== original.claims.length) {
    throw new Error("repair changed the claim count");
  }

  const rejected = new Set(unsupportedClaimIds);
  for (let index = 0; index < original.claims.length; index += 1) {
    const before = original.claims[index];
    const after = proposed.claims[index];
    if (after.id !== before.id) {
      throw new Error(`repair changed claim identity/order at ${before.id}`);
    }
    if (!sameJson(after.support, before.support)) {
      throw new Error(`repair changed locked support for ${before.id}`);
    }
    if (!rejected.has(before.id) && after.statement !== before.statement) {
      throw new Error(`repair changed accepted claim ${before.id}`);
    }
    if (!after.statement?.trim()) {
      throw new Error(`repair emptied claim ${before.id}`);
    }
  }

  for (const beatName of BEAT_NAMES) {
    const before = original.beats[beatName];
    const after = proposed.beats[beatName];
    if (!sameJson(after.claimIds, before.claimIds)) {
      throw new Error(`repair changed ${beatName} claim bindings`);
    }
    const mayChange =
      !["hook", "close"].includes(beatName) &&
      before.claimIds.some((claimId) => rejected.has(claimId));
    if (!mayChange && after.text !== before.text) {
      throw new Error(`repair changed locked ${beatName} copy`);
    }
    if (!after.text?.trim()) {
      throw new Error(`repair emptied ${beatName} copy`);
    }
  }

  return {
    schema: original.schema,
    claims: proposed.claims.map(cloneClaim),
    beats: Object.fromEntries(
      BEAT_NAMES.map((name) => [name, cloneBeat(proposed.beats[name])]),
    ) as ShortEpisodeDraft["beats"],
  };
}
