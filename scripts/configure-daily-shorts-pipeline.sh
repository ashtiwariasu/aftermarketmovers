#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-amm-daily-top-two-shorts}"
SCHEDULER_JOB="${SCHEDULER_JOB:-amm-daily-top-two-shorts}"
RECOVERY_JOB="${RECOVERY_JOB:-amm-daily-top-two-shorts-recovery}"
RECOVERY_SCHEDULER_JOB="${RECOVERY_SCHEDULER_JOB:-amm-daily-top-two-shorts-recovery}"
REPOSITORY="${REPOSITORY:-amm-jobs}"
BUCKET="${BUCKET:-${PROJECT_ID}-amm-short-artifacts}"
CHANNEL_ID="${YOUTUBE_CHANNEL_ID:?set YOUTUBE_CHANNEL_ID}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/daily-shorts:$(git rev-parse --short HEAD)"
RUNTIME_SERVICE="${RUNTIME_SERVICE:-aftermarketmovers}"

for dependency in gcloud git; do
  command -v "$dependency" >/dev/null || {
    echo "$dependency is required" >&2
    exit 1
  }
done

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy a dirty source tree; commit and verify the exact revision first." >&2
  exit 1
fi

for secret in \
  OPENROUTER_API_KEY \
  amm-heygen-api-key \
  amm-youtube-client-id \
  amm-youtube-client-secret \
  amm-youtube-refresh-token \
  AMM_RESEND_API_KEY
do
  gcloud secrets describe "$secret" --project="$PROJECT_ID" >/dev/null 2>&1 || {
    echo "Missing Secret Manager secret: $secret" >&2
    exit 1
  }
done

if ! gcloud artifacts repositories describe "$REPOSITORY" \
  --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1
then
  gcloud artifacts repositories create "$REPOSITORY" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --repository-format=docker \
    --description="AMM production jobs"
fi

if ! gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access
fi

gcloud builds submit . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --config=tools/shorts/cloudbuild.daily.yaml \
  --substitutions="_IMAGE=$IMAGE"

RUNTIME_SERVICE_ACCOUNT="$(
  gcloud run services describe "$RUNTIME_SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(spec.template.spec.serviceAccountName)'
)"
if [[ -z "$RUNTIME_SERVICE_ACCOUNT" ]]; then
  echo "Could not resolve the production runtime service account" >&2
  exit 1
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SERVICE_ACCOUNT" \
  --role=roles/storage.objectAdmin >/dev/null

COMMON=(
  --project="$PROJECT_ID"
  --region="$REGION"
  --image="$IMAGE"
  --service-account="$RUNTIME_SERVICE_ACCOUNT"
  --tasks=1
  --parallelism=1
  --max-retries=1
  --task-timeout=21600s
  --cpu=4
  --memory=8Gi
  --command=npx
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,AMM_SHORT_ARTIFACT_ROOT=/mnt/shorts,AMM_SHORT_OUTPUT_ROOT=/mnt/shorts/renders,YOUTUBE_CHANNEL_ID=$CHANNEL_ID"
  --set-secrets="OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,HEYGEN_API_KEY=amm-heygen-api-key:latest,YOUTUBE_CLIENT_ID=amm-youtube-client-id:latest,YOUTUBE_CLIENT_SECRET=amm-youtube-client-secret:latest,YOUTUBE_REFRESH_TOKEN=amm-youtube-refresh-token:latest,RESEND_API_KEY=AMM_RESEND_API_KEY:latest"
)

configure_run_job() {
  local job_name="$1"
  local args="$2"
  if gcloud run jobs describe "$job_name" \
    --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1
  then
    gcloud run jobs update "$job_name" "${COMMON[@]}" --args="$args"
  else
    gcloud run jobs create "$job_name" "${COMMON[@]}" --args="$args" \
      --add-volume="name=short-artifacts,type=cloud-storage,bucket=$BUCKET" \
      --add-volume-mount="volume=short-artifacts,mount-path=/mnt/shorts"
  fi
}

configure_run_job "$JOB" "tsx,tools/shorts/run-daily-pipeline.ts,--publish"
configure_run_job \
  "$RECOVERY_JOB" \
  "tsx,tools/shorts/run-daily-pipeline.ts,--publish,--recovery"

SCHEDULER_SERVICE_ACCOUNT="amm-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SCHEDULER_SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1
then
  gcloud iam service-accounts create amm-scheduler \
    --project="$PROJECT_ID" \
    --display-name="AMM scheduled production jobs"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SCHEDULER_SERVICE_ACCOUNT" \
  --role=roles/run.invoker \
  --condition=None >/dev/null

configure_scheduler() {
  local scheduler_name="$1"
  local run_job="$2"
  local schedule="$3"
  local run_uri
  run_uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$run_job:run"
  local scheduler_args=(
    --project="$PROJECT_ID"
    --location="$REGION"
    --schedule="$schedule"
    --time-zone="America/New_York"
    --uri="$run_uri"
    --http-method=POST
    --oauth-service-account-email="$SCHEDULER_SERVICE_ACCOUNT"
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
    --message-body="{}"
    --attempt-deadline=30m
    --max-retry-attempts=2
    --min-backoff=10m
    --max-backoff=30m
  )
  if gcloud scheduler jobs describe "$scheduler_name" \
    --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1
  then
    gcloud scheduler jobs update http "$scheduler_name" "${scheduler_args[@]}" \
      --update-headers="Content-Type=application/json"
  else
    gcloud scheduler jobs create http "$scheduler_name" "${scheduler_args[@]}" \
      --headers="Content-Type=application/json"
  fi
}

configure_scheduler "$SCHEDULER_JOB" "$JOB" "0 5 * * *"
configure_scheduler "$RECOVERY_SCHEDULER_JOB" "$RECOVERY_JOB" "0,15,30 7 * * *"

printf 'Daily Shorts pipeline configured\n'
printf '  source commit: %s\n' "$(git rev-parse HEAD)"
printf '  image: %s\n' "$IMAGE"
printf '  job: %s\n' "$JOB"
printf '  schedule: 05:00 America/New_York, daily (2 weekday Shorts; 1 non-trading-day recap)\n'
printf '  recovery job: %s\n' "$RECOVERY_JOB"
printf '  recovery schedule: 07:00, 07:15 and 07:30 America/New_York, daily (idempotent, no quality-gate relaxation)\n'
printf '  channel: %s\n' "$CHANNEL_ID"
printf '  artifacts: gs://%s\n' "$BUCKET"
