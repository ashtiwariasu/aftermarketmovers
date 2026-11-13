#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB_PREFIX="${DOSSIER_JOB:-amm-dossiers}"
SHARD_COUNT="${DOSSIER_SHARD_COUNT:-9}"
START_MINUTES="${DOSSIER_START_MINUTES:-30}"
STAGGER_MINUTES="${DOSSIER_STAGGER_MINUTES:-10}"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

if [[ -z "${CRON_TOKEN:-}" ]]; then
  echo "CRON_TOKEN must be provided without placing it in this script." >&2
  exit 1
fi

if ! [[ "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]] || (( SHARD_COUNT > 32 )); then
  echo "DOSSIER_SHARD_COUNT must be an integer between 1 and 32." >&2
  exit 1
fi
if ! [[ "$START_MINUTES" =~ ^[0-9]+$ && "$STAGGER_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "DOSSIER_START_MINUTES and DOSSIER_STAGGER_MINUTES must be non-negative integers." >&2
  exit 1
fi

# This is one logical pre-market research cycle, split into deterministic
# ticker shards. Each ticker still gets the complete evidence packet, five
# ballots and chairman pass. Sharding only buys wall-clock capacity. Staggering
# avoids a model-provider burst, while idempotent dossier receipts make all
# Scheduler retries safe and prevent duplicate council spend.
for (( shard=0; shard<SHARD_COUNT; shard++ )); do
  offset=$((START_MINUTES + shard * STAGGER_MINUTES))
  hour=$((offset / 60))
  minute=$((offset % 60))
  if (( hour > 4 )); then
    echo "Shard $shard would start after 04:59 ET and collide with downstream work." >&2
    exit 1
  fi
  if (( shard == 0 )); then
    job="$JOB_PREFIX"
  else
    job="$JOB_PREFIX-$shard"
  fi
  common=(
    --project="$PROJECT_ID"
    --location="$REGION"
    --schedule="$minute $hour * * 1-5"
    --time-zone="America/New_York"
    --uri="$SERVICE_URL/api/cron/dossiers?shard=$shard&shards=$SHARD_COUNT"
    --http-method=POST
    --attempt-deadline=25m
    --max-retry-attempts=5
    --min-backoff=1m
    --max-backoff=20m
    --max-doublings=4
  )

  if gcloud scheduler jobs describe "$job" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$job" "${common[@]}" \
      --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
  else
    gcloud scheduler jobs create http "$job" "${common[@]}" \
      --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
  fi
done

printf 'Configured %s deterministic dossier shards\n' "$SHARD_COUNT"
