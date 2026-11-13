# AMM Daily Shorts

One released dossier becomes one locked 36–46 second weekday episode. The five
analysts are not rerun. A compact editor and an independent entailment auditor
see only the released dossier bundle; deterministic gates and the audit receipt
remain the authority. Non-trading-day briefings remain a separate 50–70 second
multi-stock format.

## Daily top-two publisher

`run-daily-pipeline.ts` is the production selector and publisher. It runs after
the once-daily dossier fleet and considers only actively watched
launch-universe stocks. On a US equity trading day a successful edition
publishes **exactly two** same-day, single-company videos.

Non-trading days are a different product, delegated to
`run-weekly-pipeline.ts`:

- Saturday: one 50–70 second **weekly review** of five or six recognisable
  stocks with AMM's clearest standing-thesis reads;
- Sunday and a full-day NYSE holiday: one 50–70 second **week-ahead** briefing
  covering five or six stocks from the latest completed research.

The weekday pair is a production invariant, not a ceiling: no partial
one-video edition is accepted. The selector ranks all released,
evidence-cleared candidates and freezes the best two. If a complete pair is
unavailable, the job fails and alerts before paid rendering rather than
padding the edition or quietly publishing one. Weekend stock counts remain
evidence-gated ceilings.

A thesis qualifies only when all of these are true:

- exact v5 release-ready dossier from the completed target research date;
- approved high-interest U.S. universe: AAPL, AMD, AMZN, GOOGL, META, MSFT,
  NVDA, PLTR, TSLA;
- at least 3/5 SUPPORT (the released-dossier majority floor);
- editorial strength at least 50/100, with materiality and evidence at least
  4/5 and novelty and asymmetry at least 3/5;
- at least two non-social sources actually cited by the video-admitted dossier
  fields, including at least one primary or company source;
- the exact dossier artifact has never been published.

Ranking is confidence first, opposition penalty second, editorial quality
third. Public familiarity is only a tie-breaker; celebrity never rescues weak
research. The date selection is immutable in Firestore, while each publication
uses a deterministic dossier key and lease. A retry searches the channel for
the immutable episode ID before uploading, so a process crash cannot normally
create a duplicate.

```bash
# Read-only: inspect the completed prior ET dossier date. No model or video cost.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-daily-pipeline.ts

# Render qualified episodes without uploading.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-daily-pipeline.ts --render

# Production: render, QC, and schedule on the verified AI and Ash channel.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-daily-pipeline.ts --publish
```

Normal publishing slots are 8:30 AM and 8:45 AM America/New_York on actual US
equity trading days. The same-day dossier fleet starts at 12:30 AM ET; the
Cloud Run Shorts job starts at 5:00 AM and may wait up to 90 minutes for its
final released artifacts. If a weekday render misses the same-day pre-market
window, it fails closed. Research is never held over as a weekday prediction;
the next US equity trading day generates a fresh pair.

On a non-trading day, the scheduler selects five or six qualifying dossiers
from the prior completed trading session and schedules one 9:00 AM ET
briefing. The Saturday selector reads the last five completed trading days of
stored lifecycle receipts to rank genuine standing-thesis movement. Historical
records affect ranking only: the spoken claims remain bound to each company's
latest released dossier and its frozen source excerpts.

Every selected stock receives exactly two spoken sentences: one states how the
standing thesis held, strengthened or weakened; one explains the useful
evidence or next company test in plain language. The editor cannot browse the
web, cross evidence between companies, add a new event, or make a short-window
prediction. Every sentence must exactly match a claim with a verbatim,
same-company dossier quote and an admitted citation. An independent verifier
checks the complete package before the paid render boundary.

The weekend briefing has its own consistent editorial pair: the approved
**Confident professional in a modern office** look
(`a0e959fae7734dd194867b4c927616be`) with that avatar's default matched female
**Sharp Analyst (US)** voice (`piUdgk6WsLl3OR5GSW0j`). Weekday Shorts use
one fixed presenter look and its matched voice, set per deployment. There is no
character or voice fallback.
Preflight requires Avatar V support plus exact look group, display name, voice
name and voice gender; any mismatch blocks before a paid render.

```bash
# Read-only weekly selection. No model, video, database write or publishing.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-weekly-pipeline.ts --target-date 2026-07-24

# Lock the selection, draft, verify and render without uploading.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-weekly-pipeline.ts \
  --target-date 2026-07-24 --render

# Production: same gates, then schedule the single non-trading-day briefing.
GOOGLE_CLOUD_PROJECT=your-project \
  npx tsx tools/shorts/run-weekly-pipeline.ts --publish
```

If an exact next-results date is not established, graphics say
`NEXT RESULTS · DATE PENDING`. Weekend graphics describe thesis state across
the reporting cycle; they do not show the retired 10–15-session forecast
window.

Uploads begin as private scheduled videos and set YouTube's synthetic-content
flag, not-made-for-kids state, Science & Technology category, dossier trace,
source list, disclaimer, and exact episode ID.

The Cloud Run Job waits up to 90 minutes for every watched eligible ticker to
have either a released dossier or an honest rejected/no-directional artifact,
with an immutable daily-check receipt pointing to that accepted artifact.
Pending and terminally failed tickers keep the fleet incomplete; stale
dossiers are never substituted. The job therefore publishes Shorts only after
the complete followed-stock fleet has been checked for that research date and
the completed cohort supplies exactly two qualified weekday Shorts. Otherwise
it fails and sends one deduplicated alert to `SHORTS_ALERT_EMAIL`.
Retries re-prove fleet completion before resuming a frozen pair. All packages,
manifests, SRTs, cards, final videos and QC receipts live on a mounted versioned
GCS artifact volume.

One-time YouTube setup requires a Google OAuth **Desktop app** client with the
YouTube Data API enabled:

```bash
YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... \
  npx tsx tools/shorts/authorize-youtube.ts
```

The loopback flow verifies the channel in `YOUTUBE_CHANNEL_ID` before writing
the refresh token directly to Secret Manager. It never prints or stores that
token in the repository. Once the client ID and secret are also stored under
the names checked by the configuration script, deploy the job and scheduler:

```bash
scripts/configure-daily-shorts-pipeline.sh
```

## Production flow

```bash
# Canonical daily command for any ticker with a released dossier. Without
# --render it performs every copy, identity, card and HeyGen preflight check
# but purchases no video.
tools/shorts/make-daily-short.sh --ticker META

# Cross the paid boundary only after every gate passes. Re-running the same
# episode resumes its saved HeyGen id instead of purchasing a duplicate.
tools/shorts/make-daily-short.sh --ticker META --render

# An offline dossier works the same way. Supply its canonical text identity
# when market metadata is unavailable.
tools/shorts/make-daily-short.sh \
  --dossier /path/to/dossier.json \
  --company-name "Meta Platforms" \
  --render

# The two underlying stages remain independently callable for diagnosis.
npx tsx tools/shorts/draft-short.ts --ticker META
tools/shorts/make-episode.sh \
  tools/shorts/out/META-2026-07-22/episode-package.json

# Keep an A/B comparison in an isolated output folder and filename.
AMM_SHORT_VARIANT=answer-first tools/shorts/make-episode.sh \
  tools/shorts/out/META-2026-07-22-answer-first/episode-package.json

# Optional: exercise package, cards, API presenter/voice and Avatar V support
# without crossing the paid render boundary.
tools/shorts/make-episode.sh \
  tools/shorts/out/META-2026-07-22/episode-package.json --preflight-only
```

For offline review or backfill, replace `--ticker META` with
`--dossier /path/to/released-dossier.json`.

## Release contract

Before the paid render boundary, all of these must pass:

- exact v5 dossier release validation, immutable brief/council audit IDs;
- a valid continuous-thesis lifecycle receipt linking today’s observation to
  the same active proposition opened earlier in the reporting cycle;
- weekday template version `amm-weekday-locked-v3`, with the exact ordered
  beats `hook → change → evidence → thesis → council → close`;
- the code-owned hook (`COMPANY. AMM thesis: DIRECTION.`) and the
  code-owned spoken and visual CTA; generated copy cannot override either;
- one dossier source quote and admitted citation for every spoken factual
  sentence;
- no numeric fact absent from the sentence's cited dossier support;
- independent closed-book entailment audit;
- public-copy compliance gate;
- weekday copy of 68–78 words, calibrated to the locked Ash voice's measured
  36–46 second delivery; weekend
  copy remains 150–175 words for a 50–70 second multi-stock briefing;
- immutable episode ID over dossier hash + source bundle + approved copy.

After rendering, `qc.py` blocks release unless the result is 1080×1920 H.264,
uses the exact approved avatar/voice identities, follows the six scene timing
windows, contains audio, measures −14±1 LUFS with a safe true peak and contains
no long black segment. Weekday runtime must be 36–46 seconds; weekend runtime
must be 50–70 seconds. The QC receipt binds the final video SHA-256 to the
dossier and source-bundle hashes.

The output folder contains:

- `dossier.json` — exact released input;
- `draft.json` — the approved six-beat spoken copy and claim links;
- `copy-audit.json` — editor/verifier models, usage and response hashes;
- `episode-package.json` — immutable renderer input;
- `source-description.txt` — publishable source list and dossier trace URL;
- `render-manifest.json` — HeyGen video ID, exact presenter/voice/engine and
  resume state;
- `subtitles.srt` — HeyGen's sidecar timing file for the locked spoken text;
- `beat-timings.json` — deterministic alignment of that timing to the six
  audited beats;
- `caption-copy.json` — the exact on-card caption chunks used for visual
  review, preserving quantities with their units;
- `qc-receipt.json` — final media measurements and content hashes.

Each new episode binds a plain-text company identity into its immutable
package. The resolver accepts an explicit name, otherwise requires matching
market metadata; if that lookup is unavailable it renders the dossier-bound
ticker alone. It never guesses a company name or draws an unofficial issuer
logo.

## Locked 36–46 second weekday story

The scene sequence, Ash identity and CTA are code-owned. Only the
dossier-supported stock facts may change:

1. **0–3s · hook** — `COMPANY. AMM thesis: DIRECTION.` The dated episode
   header remains visible, so the spoken hook spends its first seconds only on
   the decision-relevant read.
2. **3–8s · change** — one plain-language, dossier-backed development.
3. **8–17s · evidence** — one or two decisive quantities, rendered as graphics
   with their units rather than a dense paragraph.
4. **17–24s · synthesis** — what the evidence means for the standing thesis.
5. **24–32s · council** — support count plus the strongest honest reservation.
6. **32–38s · close** — `For daily thesis updates and evidence, visit
   aftermarketmovers dot com.`

The visual close is always `TRACK THE THESIS DAILY` with
`AFTERMARKETMOVERS.COM`. A weekday package is rejected for altered scene order,
hook, CTA, timing, horizon language or insufficient source support.

The weekday production look is one HeyGen presenter you choose, set with `HEYGEN_AVATAR_ID`,
`HEYGEN_AVATAR_GROUP` and `HEYGEN_PRESENTER_NAME`, with its matched voice in `HEYGEN_VOICE_ID` and
`HEYGEN_VOICE_NAME`. The preflight verifies the exact look,
group, presenter name, voice name and male gender, and refuses the job unless
the avatar advertises `avatar_v` support. The payload explicitly requests
`engine.type = avatar_v`; omission would let HeyGen fall back to Avatar IV.

HeyGen receives one immutable script and produces one continuous presenter
performance plus an SRT sidecar. It does not receive dossier sources, prompts
for new copy, or AMM's evidence cards. Subtitle/script alignment must be at
least 90% before cards can be timed, so an altered transcript cannot quietly
enter the finished video.

If the cloned voice delivers a valid script slightly too slowly, the local
finisher may tighten the complete performance, capped at 1.15×. Cards and voice
are adjusted together, so synchronisation is preserved. A larger correction
blocks release and requires a rewritten script. Final audio uses measured
two-pass normalisation rather than an approximate volume boost.

## Brand and design

Bricolage Grotesque 800 for display, IBM Plex Mono for labels, paper
`#F4F1EA`, ink `#16150F`, blue `#2B4BF2`, orange `#FF4D1F`, lime
`#D9F45B`. Every triangle uses the AMM polygon `6,0 12,11 0,11`, rotated
`+12deg`, and stays orange. The direction rail is generated from the immutable
signal state; it supports gentle, moderate and strong in both directions.

The presenter carries the whole speech. All research graphics and captions
are generated and composited locally so the video model cannot reinterpret
facts or branding. The final media gate also binds the Avatar V engine,
presenter id and Ash voice id into its release receipt.

The locked weekday layout keeps Ash continuously visible in the upper presenter
zone while reserving roughly two-thirds of the frame for large, phone-readable
AMM graphics. Each scene changes the lower panel without changing presenter
identity, framing or brand system. The hook gives the answer immediately; the
evidence scene visualises the decisive numbers; the council scene shows the
vote split; and the final scene is a single strong CTA. There is no unrelated
stock footage, unofficial issuer logo, alternative presenter or dark alternate
visual identity.

`make_music.py` creates a quiet, deterministic, sample-free AMM instrumental
bed. It contains no licensed recording or external music input. The bed is
mixed beneath the voice before two-pass loudness normalisation, and its
SHA-256 plus the `AMM procedural original v1` source label enter the QC
receipt.

## Dependencies and credentials

Chrome/Chromium, ffmpeg/ffprobe, Python 3, Node/tsx and gcloud. Set
`CHROME_BIN` in containers. The HeyGen key is read from Secret Manager
`amm-heygen-api-key` in your project's Secret Manager; it never enters files or logs.
OpenRouter model costs are returned in `copy-audit.json`.

`episodes/legacy/` contains the two pre-contract prototypes for visual
comparison only. The renderer deliberately refuses them because they predate
dossier binding and must never be republished as validated episodes.
