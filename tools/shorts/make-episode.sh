#!/usr/bin/env bash
# Validated package → one idempotent Avatar V render → local brand finish → QC.
set -euo pipefail

PACKAGE="${1:-}"
[ -n "$PACKAGE" ] || {
  echo "usage: make-episode.sh path/to/episode-package.json [--preflight-only|--force-new-render]"
  exit 2
}
MODE="${2:-}"
case "$MODE" in
  ""|--preflight-only|--force-new-render) ;;
  *) echo "unknown mode: $MODE"; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$(dirname "$PACKAGE")" && pwd)"
DOSSIER="$DIR/dossier.json"
[ -f "$DOSSIER" ] || { echo "BLOCKED: dossier snapshot missing beside package: $DOSSIER"; exit 1; }

TICKER=$(python3 -c "import json;print(json.load(open('$PACKAGE'))['dossier']['ticker'])")
DATE=$(python3 -c "import json;print(json.load(open('$PACKAGE'))['dossier']['date'])")
EPISODE_ID=$(python3 -c "import json;print(json.load(open('$PACKAGE'))['episodeId'])")
FORMAT=$(python3 -c "import json;print(json.load(open('$PACKAGE')).get('format','weekday'))")
VARIANT="${AMM_SHORT_VARIANT:-}"
if [ -n "$VARIANT" ] && ! [[ "$VARIANT" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "BLOCKED: AMM_SHORT_VARIANT must be lowercase letters, numbers and hyphens"
  exit 1
fi
SUFFIX="${VARIANT:+-$VARIANT}"
OUTPUT_ROOT="${AMM_SHORT_OUTPUT_ROOT:-$HERE/out}"
WORK="$OUTPUT_ROOT/$TICKER-$DATE$SUFFIX"
MANIFEST="$WORK/render-manifest.json"
FINAL="$OUTPUT_ROOT/$TICKER-$DATE$SUFFIX-FINISHED.mp4"
QC="$WORK/qc-receipt.json"
# Immutable API look and voice identities. Unlike an editor display name, the
# look id is render-addressable and cannot silently drift to another presenter.
if [ "$FORMAT" = "weekend-recap" ]; then
  # A deliberately different presenter and setting make the weekend recap a
  # distinct editorial ritual. This must be a look ID, not an avatar-group ID.
  # The selected look is verified against its expected group and exact display
  # name before any render is bought.
  AVATAR="${HEYGEN_WEEKEND_AVATAR_ID:-a0e959fae7734dd194867b4c927616be}"
  EXPECTED_AVATAR_GROUP="${HEYGEN_WEEKEND_AVATAR_GROUP_ID:-8ab32d5ef11d4d65ba63b58c1a1f656c}"
  EXPECTED_AVATAR_NAME="${HEYGEN_WEEKEND_AVATAR_NAME:-Confident professional in a modern office}"
  VOICE="${HEYGEN_WEEKEND_VOICE_ID:-piUdgk6WsLl3OR5GSW0j}"
  EXPECTED_VOICE_NAME="${HEYGEN_WEEKEND_VOICE_NAME:-Sharp Analyst (US)}"
  EXPECTED_VOICE_GENDER="female"
else
  # Weekday identity is one fixed presenter per deployment, set in the environment with no fallback,
  # so a render can't silently use the wrong face or voice and fail only at post-render QC.
  AVATAR="${HEYGEN_AVATAR_ID:?set HEYGEN_AVATAR_ID (your weekday HeyGen look)}"
  EXPECTED_AVATAR_GROUP="${HEYGEN_AVATAR_GROUP:?set HEYGEN_AVATAR_GROUP}"
  EXPECTED_AVATAR_NAME="${HEYGEN_PRESENTER_NAME:?set HEYGEN_PRESENTER_NAME}"
  VOICE="${HEYGEN_VOICE_ID:?set HEYGEN_VOICE_ID}"
  EXPECTED_VOICE_NAME="${HEYGEN_VOICE_NAME:?set HEYGEN_VOICE_NAME}"
  EXPECTED_VOICE_GENDER="male"
fi
mkdir -p "$WORK"

npx tsx "$HERE/verify-package.ts" "$PACKAGE" "$DOSSIER"

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
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print(d.get(sys.argv[2],""))
PY
}
manifest_set() {
  python3 - "$MANIFEST" "$1" "$2" <<'PY'
import json,os,sys,tempfile
p,k,v=sys.argv[1:4]
try: d=json.load(open(p))
except Exception: d={}
d[k]=v
fd,tmp=tempfile.mkstemp(prefix=".manifest-",dir=os.path.dirname(p),text=True)
with os.fdopen(fd,"w") as f: json.dump(d,f,indent=2); f.write("\n")
os.replace(tmp,p)
PY
}

OLD_EPISODE="$(manifest_get episodeId)"
OLD_VIDEO="$(manifest_get videoId)"
OLD_ENGINE="$(manifest_get avatarEngine)"
OLD_AVATAR="$(manifest_get avatarId)"
OLD_VOICE="$(manifest_get voiceId)"
if [ -n "$OLD_EPISODE" ] && [ "$OLD_EPISODE" != "$EPISODE_ID" ] && [ "$MODE" != "--force-new-render" ]; then
  echo "BLOCKED: output folder belongs to episode $OLD_EPISODE; use --force-new-render explicitly"
  exit 1
fi
if [ -f "$FINAL" ] && [ -f "$QC" ] && [ "$OLD_EPISODE" = "$EPISODE_ID" ] \
  && [ "$OLD_ENGINE" = "avatar_v" ] \
  && [ "$OLD_AVATAR" = "$AVATAR" ] \
  && [ "$OLD_VOICE" = "$VOICE" ] \
  && [ "$(python3 -c "import json;print(json.load(open('$QC')).get('status',''))")" = "pass" ]; then
  echo "already complete: $FINAL"
  exit 0
fi

manifest_set episodeId "$EPISODE_ID"
manifest_set dossierSha256 "$(python3 -c "import json;print(json.load(open('$PACKAGE'))['dossier']['sha256'])")"
manifest_set sourceBundleSha256 "$(python3 -c "import json;print(json.load(open('$PACKAGE'))['provenance']['sourceBundleSha256'])")"
manifest_set status "preflight-passed"

python3 "$HERE/make_cards.py" "$PACKAGE" "$WORK"
manifest_set status "cards-ready"

KEY="${HEYGEN_API_KEY:-}"
if [ -z "$KEY" ]; then
  command -v gcloud >/dev/null || {
    echo "HEYGEN_API_KEY is required when gcloud is unavailable"
    exit 1
  }
  KEY=$(gcloud secrets versions access latest --secret=amm-heygen-api-key --project="${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}")
fi

# Read-only API preflight: a video render accepts a look ID, not a group ID.
# Hard-fail instead of silently accepting a different presenter, group, voice,
# or lower-quality engine.
curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
  --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
  "https://api.heygen.com/v3/avatars/looks/$AVATAR" > "$WORK/avatar.json"
curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
  --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
  "https://api.heygen.com/v3/voices/$VOICE" > "$WORK/voice.json"
python3 - "$WORK/avatar.json" "$WORK/voice.json" "$AVATAR" "$VOICE" "$FORMAT" \
  "$EXPECTED_AVATAR_GROUP" "$EXPECTED_AVATAR_NAME" "$EXPECTED_VOICE_NAME" \
  "$EXPECTED_VOICE_GENDER" <<'PY'
import json,sys
avatar=json.load(open(sys.argv[1])).get("data",{})
voice=json.load(open(sys.argv[2])).get("data",{})
assert avatar.get("id")==sys.argv[3], "HeyGen returned a different avatar"
assert "avatar_v" in avatar.get("supported_api_engines",[]), "avatar does not support Avatar V"
assert avatar.get("group_id")==sys.argv[6], "look belongs to an unexpected avatar group"
assert avatar.get("name")==sys.argv[7], "look name does not match the approved presenter"
assert voice.get("voice_id")==sys.argv[4], "HeyGen returned a different voice"
assert voice.get("name")==sys.argv[8], "configured voice name does not match the approved presenter pair"
assert voice.get("gender")==sys.argv[9], "configured voice gender does not match the approved presenter pair"
PY
python3 "$HERE/heygen_payload.py" "$PACKAGE" "$WORK/payload.json" "$AVATAR" "$VOICE"
VID="$OLD_VIDEO"
if [ -n "$VID" ] && { [ "$OLD_ENGINE" != "avatar_v" ] \
  || [ "$OLD_AVATAR" != "$AVATAR" ] \
  || [ "$OLD_VOICE" != "$VOICE" ]; }; then
  if [ "$MODE" = "--force-new-render" ]; then
    manifest_set previousVideoId "$VID"
    manifest_set videoId ""
    VID=""
    rm -f "$WORK/base.mp4" "$WORK/subtitles.srt" "$WORK/status.json" \
      "$WORK/submit.json" "$FINAL" "$QC"
  else
    echo "BLOCKED: existing video was rendered with a different presenter, voice or engine"
    exit 1
  fi
fi
if [ -n "$VID" ] && [ "$MODE" = "--force-new-render" ]; then
  manifest_set previousVideoId "$VID"
  manifest_set videoId ""
  VID=""
  rm -f "$WORK/base.mp4" "$WORK/subtitles.srt" "$WORK/status.json" \
    "$WORK/submit.json" "$FINAL" "$QC"
fi
manifest_set avatarId "$AVATAR"
manifest_set avatarName "$(python3 -c "import json;print(json.load(open('$WORK/avatar.json'))['data']['name'])")"
manifest_set avatarEngine "avatar_v"
manifest_set voiceId "$VOICE"
manifest_set voiceName "$(python3 -c "import json;print(json.load(open('$WORK/voice.json'))['data']['name'])")"
RENDER_REQUEST_ID="$(
  printf '%s|%s|%s|avatar_v' "$EPISODE_ID" "$AVATAR" "$VOICE" \
    | sha256_stdin | cut -c1-40
)"
manifest_set renderRequestId "$RENDER_REQUEST_ID"
manifest_set status "heygen-preflight-passed"
if [ "$MODE" = "--preflight-only" ]; then
  echo "preflight passed — no HeyGen render purchased"
  exit 0
fi
if [ -z "$VID" ]; then
  # Paid boundary. HeyGen's idempotency key makes a network retry safe without
  # purchasing a duplicate render. It binds the immutable episode, presenter,
  # voice and engine, so a corrected presenter cannot reuse a failed request.
  curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 120 \
    -X POST "https://api.heygen.com/v3/videos" -H "x-api-key: $KEY" \
    -H "content-type: application/json" \
    -H "Idempotency-Key: amm-short-$RENDER_REQUEST_ID" \
    --data @"$WORK/payload.json" > "$WORK/submit.json"
  VID=$(python3 -c "import json;print(json.load(open('$WORK/submit.json'))['data']['video_id'])")
  manifest_set videoId "$VID"
  manifest_set status "render-submitted"
  echo "render submitted once: $VID"
else
  echo "resuming render: $VID"
fi

for i in $(seq 1 90); do
  curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 60 \
    --retry 2 --retry-all-errors -H "x-api-key: $KEY" \
    "https://api.heygen.com/v3/videos/$VID" > "$WORK/status.json"
  ST=$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['status'])")
  echo "poll $i: $ST"
  manifest_set status "render-$ST"
  if [ "$ST" = "completed" ]; then
    URL=$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['video_url'])")
    SUBTITLE_URL=$(python3 -c "import json;print(json.load(open('$WORK/status.json'))['data']['subtitle_url'])")
    [ -n "$SUBTITLE_URL" ] || { echo "BLOCKED: HeyGen returned no subtitle timing file"; exit 1; }
    curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 300 \
      --retry 2 --retry-all-errors -o "$WORK/base.mp4" "$URL"
    curl --fail-with-body --silent --show-error --connect-timeout 15 --max-time 120 \
      --retry 2 --retry-all-errors -o "$WORK/subtitles.srt" "$SUBTITLE_URL"
    break
  fi
  [ "$ST" = "failed" ] && { cat "$WORK/status.json"; exit 1; }
  sleep 20
done
[ -f "$WORK/base.mp4" ] || { echo "render timed out; preserved video id $VID for resume"; exit 1; }
[ -s "$WORK/subtitles.srt" ] || { echo "render completed without usable subtitles"; exit 1; }

python3 "$HERE/finish.py" "$WORK/base.mp4" "$WORK/subtitles.srt" "$WORK" "$PACKAGE" "$FINAL"
python3 "$HERE/qc.py" "$FINAL" "$PACKAGE" "$MANIFEST" "$QC"
manifest_set status "qc-passed"
manifest_set videoSha256 "$(python3 -c "import json;print(json.load(open('$QC'))['videoSha256'])")"
echo "release-ready → $FINAL"
