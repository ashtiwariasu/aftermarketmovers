#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB="${PRIVATE_SIGNAL_JOB:-aftermarketmovers-private-signals-12h}"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

if [[ -z "${CRON_TOKEN:-}" ]]; then
  echo "CRON_TOKEN must be provided without placing it in this script." >&2
  exit 1
fi

COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="17 */12 * * *"
  --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/api/cron/private-signals"
  --http-method=POST
  --attempt-deadline=5m
  --max-retry-attempts=3
  --min-backoff=1m
  --max-backoff=30m
  --max-doublings=4
)

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
fi

