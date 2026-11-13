#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB="${JOB:-aftermarketmovers-evidence-reconcile}"

if [[ -z "${CRON_TOKEN:-}" ]]; then
  echo "CRON_TOKEN must be provided without placing it in this script." >&2
  exit 1
fi

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="23 4 * * 0"
  --time-zone="America/New_York"
  --uri="$SERVICE_URL/api/cron/evidence/reconcile"
  --http-method=POST
  --attempt-deadline=15m
  --max-retry-attempts=3
  --min-backoff=30s
  --max-backoff=5m
  --max-doublings=5
)

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
fi
