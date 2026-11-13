#!/usr/bin/env bash
# Verified 5–6-stock package → one locked Avatar V render → AMM finish → QC.
set -euo pipefail

PACKAGE="${1:-}"
[ -n "$PACKAGE" ] || {
  echo "usage: make-weekly-episode.sh episode-package.json [--preflight-only|--force-new-render]"
  exit 2
}
MODE="${2:-}"
case "$MODE" in
  ""|--preflight-only|--force-new-render) ;;
  *) echo "unknown mode: $MODE"; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$(dirname "$PACKAGE")" && pwd)"
DOSSIERS="$DIR/dossiers.json"
VERIFIER="$DIR/verifier-receipt.json"
[ -f "$DOSSIERS" ] || { echo "BLOCKED: weekly dossier snapshots are missing"; exit 1; }
[ -f "$VERIFIER" ] || { echo "BLOCKED: weekly verifier receipt is missing"; exit 1; }

PUBLICATION_DATE="$(python3 -c "import json;print(json.load(open('$PACKAGE'))['publicationDate'])")"
EDITION="$(python3 -c "import json;print(json.load(open('$PACKAGE'))['edition'])")"
EPISODE_ID="$(python3 -c "import json;print(json.load(open('$PACKAGE'))['episodeId'])")"
OUTPUT_ROOT="${AMM_SHORT_OUTPUT_ROOT:-$HERE/out}"
WORK="$OUTPUT_ROOT/weekly-$PUBLICATION_DATE-$EDITION"
FINAL="$OUTPUT_ROOT/weekly-$PUBLICATION_DATE-$EDITION-FINISHED.mp4"
MANIFEST="$WORK/render-manifest.json"
QC="$WORK/qc-receipt.json"

# The weekly editorial ritual has one fixed presenter, setting and default
# matching voice. The API metadata confirms this look's default is the female
# Sharp Analyst voice. There is deliberately no fallback: either exact identity
# missing blocks the edition instead of producing a male-voice/female-face cut.
AVATAR="${HEYGEN_WEEKLY_AVATAR_ID:-a0e959fae7734dd194867b4c927616be}"
EXPECTED_AVATAR_GROUP="${HEYGEN_WEEKLY_AVATAR_GROUP_ID:-8ab32d5ef11d4d65ba63b58c1a1f656c}"
EXPECTED_AVATAR_NAME="${HEYGEN_WEEKLY_AVATAR_NAME:-Confident professional in a modern office}"
VOICE="${HEYGEN_WEEKLY_VOICE_ID:-piUdgk6WsLl3OR5GSW0j}"
EXPECTED_VOICE_NAME="${HEYGEN_WEEKLY_VOICE_NAME:-Sharp Analyst (US)}"
EXPECTED_VOICE_GENDER="female"
mkdir -p "$WORK"

npx tsx "$HERE/verify-weekly-package.ts" "$PACKAGE" "$DOSSIERS" "$VERIFIER"

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | awk '{print $1}'
  else
    echo "BLOCKED: no SHA-256 implementation is available" >&2
    return 127
  fi
}

manifest_get() {
  python3 - "$MANIFEST" "$1" <<'PY'
import json,sys
try: value=json.load(open(sys.argv[1]))
except Exception: value={}
print(value.get(sys.argv[2],""))
PY
}
manifest_set() {
  python3 - "$MANIFEST" "$1" "$2" <<'PY'
import json,os,sys,tempfile
path,key,value=sys.argv[1:4]
try: data=json.load(open(path))
except Exception: data={}
data[key]=value
fd,tmp=tempfile.mkstemp(prefix=".manifest-",dir=os.path.dirname(path),text=True)
with os.fdopen(fd,"w") as handle:
    json.dump(data,handle,indent=2);handle.write("\n")
os.replace(tmp,path)
PY
}

OLD_EPISODE="$(manifest_get episodeId)"
OLD_VIDEO="$(manifest_get videoId)"
OLD_AVATAR="$(manifest_get avatarId)"
OLD_VOICE="$(manifest_get voiceId)"
if [ -n "$OLD_EPISODE" ] && [ "$OLD_EPISODE" != "$EPISODE_ID" ] \
  && [ "$MODE" != "--force-new-render" ]; then
  echo "BLOCKED: output belongs to another weekly episode; use --force-new-render"
  exit 1
fi
if [ -f "$FINAL" ] && [ -f "$QC" ] && [ "$OLD_EPISODE" = "$EPISODE_ID" ] \
  && [ "$OLD_AVATAR" = "$AVATAR" ] && [ "$OLD_VOICE" = "$VOICE" ] \
  && [ "$(python3 -c "import json;print(json.load(open('$QC')).get('status',''))")" = "pass" ]; then
  echo "already complete: $FINAL"
  exit 0
fi

manifest_set episodeId "$EPISODE_ID"
manifest_set sourceBundleSha256 "$(python3 -c "import json;print(json.load(open('$PACKAGE'))['provenance']['sourceBundleSha256'])")"
manifest_set status "package-verified"
python3 "$HERE/make_weekly_cards.py" "$PACKAGE" "$WORK"
manifest_set status "cards-ready"

KEY="${HEYGEN_API_KEY:-}"
if [ -z "$KEY" ]; then
  command -v gcloud >/dev/null || {
    echo "HEYGEN_API_KEY is required when gcloud is unavailable"
    exit 1
  }
  KEY="$(gcloud secrets versions access latest --secret=amm-heygen-api-key --project="${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}")"
fi

curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
  --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
  "https://api.heygen.com/v3/avatars/looks/$AVATAR" > "$WORK/avatar.json"
curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
  --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
  "https://api.heygen.com/v3/voices/$VOICE" > "$WORK/voice.json"
python3 - "$WORK/avatar.json" "$WORK/voice.json" "$AVATAR" "$VOICE" \
  "$EXPECTED_AVATAR_GROUP" "$EXPECTED_AVATAR_NAME" "$EXPECTED_VOICE_NAME" \
  "$EXPECTED_VOICE_GENDER" <<'PY'
import json,sys
avatar=json.load(open(sys.argv[1])).get("data",{})
voice=json.load(open(sys.argv[2])).get("data",{})
assert avatar.get("id")==sys.argv[3], "HeyGen returned a different avatar"
assert "avatar_v" in avatar.get("supported_api_engines",[]), "weekly avatar does not support Avatar V"
assert avatar.get("group_id")==sys.argv[5], "weekly look belongs to an unexpected avatar group"
assert avatar.get("name")==sys.argv[6], "weekly look name does not match the approved presenter"
assert voice.get("voice_id")==sys.argv[4], "HeyGen returned a different voice"
assert voice.get("name")==sys.argv[7], "weekly voice name does not match the approved presenter pair"
assert voice.get("gender")==sys.argv[8], "weekly voice gender does not match the approved presenter pair"
PY
python3 "$HERE/heygen_weekly_payload.py" "$PACKAGE" "$WORK/payload.json" "$AVATAR" "$VOICE"

if [ -n "$OLD_VIDEO" ] && { [ "$OLD_AVATAR" != "$AVATAR" ] || [ "$OLD_VOICE" != "$VOICE" ]; }; then
  [ "$MODE" = "--force-new-render" ] || {
    echo "BLOCKED: existing render used another presenter or voice"
    exit 1
  }
fi
if [ "$MODE" = "--force-new-render" ]; then
  [ -z "$OLD_VIDEO" ] || manifest_set previousVideoId "$OLD_VIDEO"
  manifest_set videoId ""
  OLD_VIDEO=""
  rm -f "$WORK/base.mp4" "$WORK/subtitles.srt" "$WORK/status.json" \
    "$WORK/submit.json" "$FINAL" "$QC"
fi

manifest_set avatarId "$AVATAR"
manifest_set avatarName "$(python3 -c "import json;print(json.load(open('$WORK/avatar.json'))['data']['name'])")"
manifest_set avatarEngine "avatar_v"
manifest_set voiceId "$VOICE"
manifest_set voiceName "$(python3 -c "import json;print(json.load(open('$WORK/voice.json'))['data']['name'])")"
REQUEST_ID="$(
  printf '%s|%s|%s|avatar_v' "$EPISODE_ID" "$AVATAR" "$VOICE" \
    | sha256_stdin | cut -c1-40
)"
manifest_set renderRequestId "$REQUEST_ID"
manifest_set status "heygen-preflight-passed"
if [ "$MODE" = "--preflight-only" ]; then
  echo "weekly preflight passed — no HeyGen render purchased"
  exit 0
fi

VID="$OLD_VIDEO"
if [ -z "$VID" ]; then
  curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 120 \
    -X POST "https://api.heygen.com/v3/videos" -H "x-api-key: $KEY" \
    -H "content-type: application/json" \
    -H "Idempotency-Key: amm-weekly-$REQUEST_ID" \
    --data @"$WORK/payload.json" > "$WORK/submit.json"
  VID="$(python3 -c "import json;print(json.load(open('$WORK/submit.json'))['data']['video_id'])")"
  manifest_set videoId "$VID"
  manifest_set status "render-submitted"
else
  echo "resuming weekly render: $VID"
fi

for attempt in $(seq 1 90); do
  curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
    --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
    "https://api.heygen.com/v3/videos/$VID" > "$WORK/status.json"
  STATUS="$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['status'])")"
  manifest_set status "render-$STATUS"
  echo "weekly render poll $attempt: $STATUS"
  if [ "$STATUS" = "completed" ]; then
    URL="$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['video_url'])")"
    SUBTITLE_URL="$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['subtitle_url'])")"
    [ -n "$SUBTITLE_URL" ] || { echo "BLOCKED: HeyGen returned no subtitles"; exit 1; }
    curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 300 \
      --retry 2 --retry-all-errors -o "$WORK/base.mp4" "$URL"
    curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 120 \
      --retry 2 --retry-all-errors -o "$WORK/subtitles.srt" "$SUBTITLE_URL"
    break
  fi
  [ "$STATUS" = "failed" ] && { cat "$WORK/status.json"; exit 1; }
  sleep 20
done
[ -s "$WORK/base.mp4" ] || { echo "weekly render timed out; video id preserved"; exit 1; }
[ -s "$WORK/subtitles.srt" ] || { echo "weekly render has no usable subtitles"; exit 1; }
python3 "$HERE/finish_weekly.py" \
  "$WORK/base.mp4" "$WORK/subtitles.srt" "$WORK" "$PACKAGE" "$FINAL"
python3 "$HERE/qc_weekly.py" "$FINAL" "$PACKAGE" "$MANIFEST" "$QC"
manifest_set status "qc-passed"
manifest_set videoSha256 "$(python3 -c "import json;print(json.load(open('$QC'))['videoSha256'])")"
echo "weekly release-ready → $FINAL"
