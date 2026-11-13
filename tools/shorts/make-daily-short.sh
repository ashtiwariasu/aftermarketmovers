#!/usr/bin/env bash
# One released dossier → audited answer-first package → one idempotent render.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE_KIND=""
SOURCE_VALUE=""
COMPANY_NAME=""
OUTPUT_DIR=""
VARIANT=""
DRAFT_PATH=""
FORMAT="weekday"
PUBLICATION_DATE=""
RENDER_MODE="--preflight-only"

usage() {
  cat <<'EOF'
usage:
  make-daily-short.sh --ticker META [--render]
  make-daily-short.sh --dossier /path/dossier.json [--company-name "Meta Platforms"] [--render]

Options:
  --render              Cross the paid HeyGen boundary after every gate passes.
  --force-new-render    Replace a cached render only after rebuilding and
                        revalidating the package from its exact dossier.
  --company-name NAME   Explicit text identity for an offline dossier.
  --draft FILE          Use reviewed copy; the independent auditor still runs.
  --out DIR             Override the audit/package output directory.
  --variant NAME        Isolate an A/B render without replacing the canonical cut.
  --format NAME         weekday (default) or weekend-recap.
  --publication-date D  Publication date (YYYY-MM-DD); required for weekend recap.

Without --render, the command completes every copy, identity, card and HeyGen
preflight gate but purchases no video.
EOF
}

while (($#)); do
  case "$1" in
    --ticker|--dossier)
      [ -z "$SOURCE_KIND" ] || { echo "choose exactly one of --ticker or --dossier"; exit 2; }
      SOURCE_KIND="$1"; SOURCE_VALUE="${2:-}"; shift 2 ;;
    --company-name) COMPANY_NAME="${2:-}"; shift 2 ;;
    --draft) DRAFT_PATH="${2:-}"; shift 2 ;;
    --out) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --variant) VARIANT="${2:-}"; shift 2 ;;
    --format) FORMAT="${2:-}"; shift 2 ;;
    --publication-date) PUBLICATION_DATE="${2:-}"; shift 2 ;;
    --render) RENDER_MODE=""; shift ;;
    --force-new-render) RENDER_MODE="--force-new-render"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1"; usage; exit 2 ;;
  esac
done

[ -n "$SOURCE_KIND" ] && [ -n "$SOURCE_VALUE" ] || { usage; exit 2; }
[ "$FORMAT" = "weekday" ] || [ "$FORMAT" = "weekend-recap" ] || {
  echo "format must be weekday or weekend-recap"
  exit 2
}
if [ "$FORMAT" = "weekend-recap" ]; then
  [[ "$PUBLICATION_DATE" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || {
    echo "weekend-recap requires --publication-date YYYY-MM-DD"
    exit 2
  }
  [ -n "$VARIANT" ] || VARIANT="weekend-recap-$PUBLICATION_DATE"
fi
if [ -n "$VARIANT" ] && ! [[ "$VARIANT" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "variant must use lowercase letters, numbers and hyphens"
  exit 2
fi
if [ "$SOURCE_KIND" = "--dossier" ]; then
  [ -f "$SOURCE_VALUE" ] || { echo "dossier not found: $SOURCE_VALUE"; exit 2; }
  SOURCE_VALUE="$(cd "$(dirname "$SOURCE_VALUE")" && pwd)/$(basename "$SOURCE_VALUE")"
fi
if [ -n "$DRAFT_PATH" ]; then
  [ -f "$DRAFT_PATH" ] || { echo "draft not found: $DRAFT_PATH"; exit 2; }
  DRAFT_PATH="$(cd "$(dirname "$DRAFT_PATH")" && pwd)/$(basename "$DRAFT_PATH")"
fi
if [ -n "$OUTPUT_DIR" ] && [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$PWD/$OUTPUT_DIR"
fi
cd "$ROOT"

DRAFT_ARGS=("$SOURCE_KIND" "$SOURCE_VALUE")
DRAFT_ARGS+=(--format "$FORMAT")
[ -z "$PUBLICATION_DATE" ] || DRAFT_ARGS+=(--publication-date "$PUBLICATION_DATE")
[ -z "$COMPANY_NAME" ] || DRAFT_ARGS+=(--company-name "$COMPANY_NAME")
[ -z "$DRAFT_PATH" ] || DRAFT_ARGS+=(--draft "$DRAFT_PATH")
[ -z "$OUTPUT_DIR" ] || DRAFT_ARGS+=(--out "$OUTPUT_DIR")

if [ -z "${OPENROUTER_API_KEY_AMM:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
  command -v gcloud >/dev/null || {
    echo "OPENROUTER_API_KEY_AMM or OPENROUTER_API_KEY is required"
    exit 1
  }
  export OPENROUTER_API_KEY="$(
    gcloud secrets versions access latest \
      --secret=OPENROUTER_API_KEY \
      --project="${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}"
  )"
fi

RESULT="$(mktemp)"
trap 'rm -f "$RESULT"' EXIT
npx tsx "$HERE/draft-short.ts" "${DRAFT_ARGS[@]}" | tee "$RESULT"
PACKAGE="$(python3 - "$RESULT" <<'PY'
import json,sys
for line in reversed(open(sys.argv[1]).read().splitlines()):
    try: value=json.loads(line)
    except Exception: continue
    if value.get("releaseReadyForRender") is True:
        print(value["package"])
        break
else:
    raise SystemExit("draft stage returned no release-ready package")
PY
)"

if [ -n "$VARIANT" ]; then
  export AMM_SHORT_VARIANT="$VARIANT"
fi
if [ -z "$RENDER_MODE" ]; then
  "$HERE/make-episode.sh" "$PACKAGE"
else
  "$HERE/make-episode.sh" "$PACKAGE" "$RENDER_MODE"
fi
