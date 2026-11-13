#!/usr/bin/env bash
# Daily social evidence ingest: 20:30 UTC, before the normal dossier run.
# This job stores traceable source records for council synthesis; it never sends
# a standalone digest or email. The same script binds the X credential and
# registers the retrying scheduler so deploys cannot leave it half-configured.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"
X_SECRET="${X_SECRET:-amm-x-bearer-token}"

gcloud secrets describe "$X_SECRET" --project="$PROJECT" >/dev/null
gcloud run services update "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --update-secrets="X_BEARER_TOKEN=$X_SECRET:latest" \
  --quiet >/dev/null

# Token remains single-sourced from the existing dossier scheduler until the
# fleet completes its planned OIDC migration.
TOKEN=$(gcloud scheduler jobs describe amm-dossiers --location="$REGION" --project="$PROJECT" --format="value(httpTarget.headers.x-cron-token)")
if [[ -z "$TOKEN" ]]; then
  echo "social-intel setup blocked: amm-dossiers has no cron token" >&2
  exit 1
fi
if gcloud scheduler jobs describe amm-social-intel --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http amm-social-intel --location="$REGION" --project="$PROJECT" \
    --schedule="30 20 * * *" --time-zone="Etc/UTC" \
    --uri="${APP_BASE_URL:?set APP_BASE_URL}/api/cron/social-intel" --http-method=POST \
    --update-headers="x-cron-token=$TOKEN" --attempt-deadline=1800s \
    --max-retry-attempts=3 --min-backoff=60s --max-backoff=600s \
    --quiet >/dev/null
else
  gcloud scheduler jobs create http amm-social-intel --location="$REGION" --project="$PROJECT" \
    --schedule="30 20 * * *" --time-zone="Etc/UTC" \
    --uri="${APP_BASE_URL:?set APP_BASE_URL}/api/cron/social-intel" --http-method=POST \
    --headers="x-cron-token=$TOKEN" --attempt-deadline=1800s \
    --max-retry-attempts=3 --min-backoff=60s --max-backoff=600s \
    --quiet >/dev/null
fi
gcloud scheduler jobs describe amm-social-intel --location="$REGION" --project="$PROJECT" --format="value(name,schedule,state)"
