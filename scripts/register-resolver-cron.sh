#!/usr/bin/env bash
# Registers the hourly thesis-resolver cron (records ActiveQuestions from fresh
# voted dossiers + resolves due ones against their oracles). Reads the current
# shared token from the amm-dossiers job so rotation stays single-source.
# Cursor: fold this job into the OIDC migration with the other three.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT}"
REGION=us-central1
TOKEN=$(gcloud scheduler jobs describe amm-dossiers --location="$REGION" --project="$PROJECT" --format="value(httpTarget.headers.x-cron-token)")
if gcloud scheduler jobs describe amm-thesis-resolver --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http amm-thesis-resolver \
    --location="$REGION" --project="$PROJECT" \
    --schedule="20 * * * *" --time-zone="America/New_York" \
    --uri="${APP_BASE_URL:?set APP_BASE_URL}/api/cron/resolve" --http-method=POST \
    --update-headers="x-cron-token=$TOKEN" --attempt-deadline=900s
else
  gcloud scheduler jobs create http amm-thesis-resolver \
    --location="$REGION" --project="$PROJECT" \
    --schedule="20 * * * *" --time-zone="America/New_York" \
    --uri="${APP_BASE_URL:?set APP_BASE_URL}/api/cron/resolve" --http-method=POST \
    --headers="x-cron-token=$TOKEN" --attempt-deadline=900s
fi
gcloud scheduler jobs describe amm-thesis-resolver --location="$REGION" --project="$PROJECT" --format="value(name,schedule,state)"
