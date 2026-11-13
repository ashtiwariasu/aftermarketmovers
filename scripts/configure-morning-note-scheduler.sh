#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
JOB="${MORNING_NOTE_JOB:-amm-morning-note}"

SERVICE_JSON="$(mktemp)"
trap 'rm -f "$SERVICE_JSON"' EXIT

gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format=json > "$SERVICE_JSON"

SERVICE_URL="$(jq -r '.status.url // empty' "$SERVICE_JSON")"
if [[ -z "$SERVICE_URL" ]]; then
  echo "Unable to resolve the Cloud Run service URL for $SERVICE." >&2
  exit 1
fi

# Bind the scheduler to the exact secret version mounted by the live service.
# This avoids the incident where Secret Manager advanced but Cloud Scheduler
# continued sending the previous x-cron-token value.
if [[ -z "${CRON_TOKEN:-}" ]]; then
  SECRET_NAME="$(jq -r '
    .spec.template.spec.containers[0].env[]
    | select(.name == "CRON_TOKEN")
    | .valueFrom.secretKeyRef.name // empty
  ' "$SERVICE_JSON")"
  SECRET_VERSION="$(jq -r '
    .spec.template.spec.containers[0].env[]
    | select(.name == "CRON_TOKEN")
    | .valueFrom.secretKeyRef.key // empty
  ' "$SERVICE_JSON")"
  if [[ -z "$SECRET_NAME" || -z "$SECRET_VERSION" ]]; then
    echo "CRON_TOKEN is not provided and the live service has no secret binding." >&2
    exit 1
  fi
  CRON_TOKEN="$(gcloud secrets versions access "$SECRET_VERSION" \
    --secret="$SECRET_NAME" --project="$PROJECT_ID")"
fi

COMMON=(
  --project="$PROJECT_ID"
  --location="$REGION"
  --schedule="0 9 * * 1-5"
  --time-zone="America/New_York"
  --uri="$SERVICE_URL/api/cron/morning-note"
  --http-method=POST
  --attempt-deadline=25m
  --max-retry-attempts=5
  --min-backoff=1m
  --max-backoff=15m
  --max-doublings=3
)

if gcloud scheduler jobs describe "$JOB" \
  --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json" >/dev/null
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" \
    --headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json" >/dev/null
fi

gcloud scheduler jobs describe "$JOB" \
  --project="$PROJECT_ID" --location="$REGION" \
  --format='table(name.basename(),schedule,state,httpTarget.uri)'
