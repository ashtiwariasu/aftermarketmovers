#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB="${JOB:-aftermarketmovers-hourly-news}"
RECONCILE_JOB="${RECONCILE_JOB:-aftermarketmovers-news-reconcile}"
HEALTH_JOB="${HEALTH_JOB:-aftermarketmovers-news-health}"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"

if [[ -z "${CRON_TOKEN:-}" ]]; then
  echo "CRON_TOKEN must be provided without placing it in this script." >&2
  exit 1
fi

COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="7 */12 * * *"
  --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/api/cron/news"
  --http-method=POST
  --attempt-deadline=30m
  --max-retry-attempts=3
  --min-backoff=30s
  --max-backoff=10m
  --max-doublings=4
)

if gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
fi

RECONCILE_COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="37 3 * * *"
  --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/api/cron/news/reconcile"
  --http-method=POST
  --attempt-deadline=30m
  --max-retry-attempts=3
  --min-backoff=1m
  --max-backoff=15m
  --max-doublings=4
)

if gcloud scheduler jobs describe "$RECONCILE_JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$RECONCILE_JOB" "${RECONCILE_COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
else
  gcloud scheduler jobs create http "$RECONCILE_JOB" "${RECONCILE_COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json"
fi

HEALTH_COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="*/15 * * * *"
  --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/api/cron/news/health"
  --http-method=GET
  --attempt-deadline=2m
  --max-retry-attempts=1
  --min-backoff=30s
  --max-backoff=1m
  --max-doublings=1
)

if gcloud scheduler jobs describe "$HEALTH_JOB" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$HEALTH_JOB" "${HEALTH_COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN"
else
  gcloud scheduler jobs create http "$HEALTH_JOB" "${HEALTH_COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN"
fi
