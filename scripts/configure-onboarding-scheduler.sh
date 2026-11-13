#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB="${ONBOARDING_JOB:-aftermarketmovers-onboarding-recovery}"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

# Match the existing cron authorization contract without placing the token in
# source. Operators may pass CRON_TOKEN directly; otherwise borrow the header
# from the already-provisioned Morning Note job.
if [[ -z "${CRON_TOKEN:-}" ]]; then
  CRON_TOKEN="$(gcloud scheduler jobs describe amm-morning-note \
    --project="$PROJECT_ID" --location="$REGION" \
    --format='value(httpTarget.headers.x-cron-token)' 2>/dev/null || true)"
fi
if [[ -z "${CRON_TOKEN:-}" ]]; then
  echo "CRON_TOKEN is required (or configure amm-morning-note first)." >&2
  exit 1
fi

COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="*/15 * * * *"
  --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/api/cron/onboarding"
  --http-method=POST
  --attempt-deadline=5m
  --max-retry-attempts=5
  --min-backoff=1m
  --max-backoff=15m
  --max-doublings=3
)

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json" >/dev/null
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json" >/dev/null
fi

gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" \
  --format='table(name.basename(),schedule,state,httpTarget.uri)'
