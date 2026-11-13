# AMM: After Market Movers

The code behind [aftermarketmovers.com](https://aftermarketmovers.com). You pick the companies you follow; overnight,
the Desk reads what changed (SEC filings, market data, licensed news), a council of AI models writes and audits a
sourced thesis for each one, and a Morning Note lands in your inbox before the market opens.

AMM publishes research summaries, not financial advice.

## What's in here

- **The site and the Desk** (`src/app`, `src/lib`): a Next.js 16 app. Public pages for after-hours and premarket
  movers and per-company files; a signed-in Desk where members watch companies, read each day's dossier and ask the
  Desk questions about a company's file.
- **The research pipeline** (`src/lib`): company data from SEC EDGAR (filings and XBRL fundamentals) and market data,
  a news and provenance pipeline for licensed providers, and the council that drafts a daily thesis, has it checked
  by separate numbers, risk and evidence reviewers, and has a chair merge the result. Scheduled work runs through
  token-protected routes under `src/app/api/cron`.
- **Morning Notes** (`src/lib/notifications.ts` and the cron routes): email through Resend, sent at each member's
  chosen local time, fail-closed outside production.
- **Billing** (`src/app/api/billing`): Stripe subscriptions with a webhook as the only writer of a member's tier.
- **iOS app** (`ios/AMM`): a native, voice-first client for the same Desk. See `ios/AMM/README.md`.
- **Shorts** (`tools/shorts`): the pipeline that turns the day's strongest thesis into a vertical video with a HeyGen
  presenter and publishes it to YouTube. See `tools/shorts/README.md`.

## Run it locally

```bash
npm ci
cp .env.example .env.local      # then fill in what you need
DESK_STORE=memory npm run dev
```

Open http://localhost:3000. With `DESK_STORE=memory` desks and company data stay in memory instead of Firestore.
Sign-in needs your own [Clerk](https://clerk.com) keys; models need an OpenRouter key; email, billing and news
providers stay off until you add their keys. Every setting is listed, with comments, in `.env.example`.

Run the tests with `npm test`.

## Deploy your own

The `Dockerfile` builds a standalone Next.js server that runs anywhere containers do (the hosted site uses Google
Cloud Run). Public client-side keys are baked in at build time, so pass your own:

```bash
docker build --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_... \
             --build-arg NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_... -t amm .
```

Then set the server-side variables from `.env.example` in your runtime, and call the routes under `/api/cron` from a
scheduler with your `CRON_TOKEN`.

`src/lib/environment.ts` refuses unsafe combinations outside production: emails must go to a sink address, billing
can't use live keys, and a development service sharing production data must name the production Google Cloud project
in `AMM_PRODUCTION_PROJECT_ID`.

## Data

The code ships no market data or news. SEC EDGAR is free and keyless, but asks every client for a contact address:
set `CONTACT_USER_AGENT` to yours. Licensed news needs your own account with a provider listed in `.env.example`, used under its terms.

## Licence

[MIT](LICENSE).
