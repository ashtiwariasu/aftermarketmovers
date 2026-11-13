#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
ALERT_EMAIL="${ALERT_EMAIL:?set ALERT_EMAIL}"
POLICY_NAME="${POLICY_NAME:-AMM production failures}"

for dependency in curl gcloud jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "$dependency is required." >&2
    exit 1
  fi
done

ensure_log_metric() {
  local name="$1"
  local description="$2"
  local filter="$3"
  if gcloud logging metrics describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud logging metrics update "$name" \
      --project="$PROJECT_ID" \
      --description="$description" \
      --log-filter="$filter" >/dev/null
  else
    gcloud logging metrics create "$name" \
      --project="$PROJECT_ID" \
      --description="$description" \
      --log-filter="$filter" >/dev/null
  fi
}

ensure_log_metric \
  "amm_scheduler_job_failures" \
  "Failed AMM Cloud Scheduler executions." \
  'resource.type="cloud_scheduler_job"
jsonPayload."@type"="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"
severity>=ERROR'

ensure_log_metric \
  "amm_cloud_run_failures" \
  "Errors emitted by the production AMM Cloud Run service." \
  'resource.type="cloud_run_revision"
resource.labels.service_name="aftermarketmovers"
severity>=ERROR'

ACCESS_TOKEN="$(gcloud auth print-access-token)"
AUTH_HEADER="Authorization: Bearer $ACCESS_TOKEN"
API_ROOT="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"

CHANNELS="$(curl -fsS "$API_ROOT/notificationChannels?pageSize=1000" -H "$AUTH_HEADER")"
CHANNEL_NAME="$(printf '%s' "$CHANNELS" | jq -r --arg email "$ALERT_EMAIL" '
  [.notificationChannels[]?
    | select(.type == "email" and .labels.email_address == $email)
    | .name][0] // empty
')"

if [[ -z "$CHANNEL_NAME" ]]; then
  CHANNEL_BODY="$(jq -n --arg email "$ALERT_EMAIL" '{
    type: "email",
    displayName: "AMM production failures",
    description: "Deduplicated production failure notifications for AMM.",
    labels: {email_address: $email},
    enabled: true
  }')"
  CHANNEL_NAME="$(curl -fsS -X POST "$API_ROOT/notificationChannels" \
    -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
    --data "$CHANNEL_BODY" | jq -r '.name')"
fi

if [[ -z "$CHANNEL_NAME" || "$CHANNEL_NAME" == "null" ]]; then
  echo "Unable to resolve the email notification channel." >&2
  exit 1
fi

POLICIES="$(curl -fsS "$API_ROOT/alertPolicies?pageSize=1000" -H "$AUTH_HEADER")"
EXISTING_POLICY="$(printf '%s' "$POLICIES" | jq -r --arg name "$POLICY_NAME" '
  [.alertPolicies[]? | select(.displayName == $name) | .name][0] // empty
')"

if [[ -z "$EXISTING_POLICY" ]]; then
  POLICY_BODY="$(jq -n \
    --arg displayName "$POLICY_NAME" \
    --arg channel "$CHANNEL_NAME" \
    '{
      displayName: $displayName,
      documentation: {
        subject: "AMM production failure",
        mimeType: "text/markdown",
        content: "AMM recorded a production failure. The incident resource identifies the scheduler job or Cloud Run revision. Inspect Cloud Logging before retrying; Monitoring deduplicates repeated failures until the incident closes."
      },
      combiner: "OR",
      enabled: true,
      notificationChannels: [$channel],
      userLabels: {product: "amm", owner: "ash"},
      alertStrategy: {
        autoClose: "1800s"
      },
      conditions: [
        {
          displayName: "AMM scheduled job failed",
          conditionThreshold: {
            filter: "resource.type=\"cloud_scheduler_job\" AND metric.type=\"logging.googleapis.com/user/amm_scheduler_job_failures\"",
            comparison: "COMPARISON_GT",
            thresholdValue: 0,
            duration: "0s",
            trigger: {count: 1},
            aggregations: [{
              alignmentPeriod: "60s",
              perSeriesAligner: "ALIGN_SUM"
            }]
          }
        },
        {
          displayName: "AMM Cloud Run emitted an error",
          conditionThreshold: {
            filter: "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/amm_cloud_run_failures\"",
            comparison: "COMPARISON_GT",
            thresholdValue: 0,
            duration: "0s",
            trigger: {count: 1},
            aggregations: [{
              alignmentPeriod: "60s",
              perSeriesAligner: "ALIGN_SUM"
            }]
          }
        }
      ]
    }')"
  EXISTING_POLICY="$(curl -fsS -X POST "$API_ROOT/alertPolicies" \
    -H "$AUTH_HEADER" -H 'Content-Type: application/json' \
    --data "$POLICY_BODY" | jq -r '.name')"
fi

printf 'Failure alerts configured\n'
printf '  email: %s\n' "$ALERT_EMAIL"
printf '  channel: %s\n' "$CHANNEL_NAME"
printf '  policy: %s\n' "$EXISTING_POLICY"
