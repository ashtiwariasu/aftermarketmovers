#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aftermarketmovers}"

for dependency in gcloud jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "$dependency is required." >&2
    exit 1
  fi
done

SERVICE_JSON="$(mktemp)"
JOBS_JSON="$(mktemp)"
trap 'rm -f "$SERVICE_JSON" "$JOBS_JSON"' EXIT

gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" --format=json > "$SERVICE_JSON"

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
  echo "The live service has no versioned CRON_TOKEN secret binding." >&2
  exit 1
fi

CRON_TOKEN="$(gcloud secrets versions access "$SECRET_VERSION" \
  --secret="$SECRET_NAME" --project="$PROJECT_ID")"

gcloud scheduler jobs list \
  --project="$PROJECT_ID" --location="$REGION" --format=json > "$JOBS_JSON"

updated=0
while IFS=$'\t' read -r job current_token; do
  [[ -n "$job" ]] || continue
  if [[ "$current_token" == "$CRON_TOKEN" ]]; then
    continue
  fi
  gcloud scheduler jobs update http "$job" \
    --project="$PROJECT_ID" --location="$REGION" \
    --update-headers="x-cron-token=$CRON_TOKEN,Content-Type=application/json" >/dev/null
  printf 'updated %s\n' "$job"
  updated=$((updated + 1))
done < <(jq -r '
  .[]
  | select(.httpTarget != null)
  | (.name | split("/")[-1]) as $job
  | select(
      ($job | startswith("amm-"))
      or ($job | startswith("aftermarketmovers-"))
      or ($job | startswith("amm-"))
    )
  | [$job, (.httpTarget.headers["x-cron-token"] // "")] | @tsv
' "$JOBS_JSON")

printf 'scheduler token sync complete: %d job(s) updated\n' "$updated"
