# AMM for iOS

AMM is a voice-first, card-based native client for the existing AMM Desk. It
does not duplicate research logic. The web and iOS clients consume the same
authenticated presentation contract and the same immutable, source-bound
voice sessions.

## Native Desk lifecycle

- A new member chooses up to three covered US-listed companies in the app.
- The existing server coverage gate verifies both primary filings and complete
  US market data before a symbol can consume a slot.
- Company changes use the same idempotent Desk mutation route as the web app;
  research logic and entitlements are not duplicated in Swift.
- The last server-authored Desk envelope is stored with complete-until-first-
  unlock file protection, in a Clerk-user-scoped hashed filename. A network
  failure therefore keeps the last verified Desk readable, clearly marked as
  saved, without crossing member boundaries.
- Foregrounding and pull-to-refresh reconcile the native view with the shared
  production Desk.

## Generate the Xcode project

```sh
cd ios/AMM
swift scripts/make-app-icon.swift
xcodegen generate
open AMM.xcodeproj
```

Set `CLERK_PUBLISHABLE_KEY` in a local, uncommitted Xcode configuration. The
default API base URL is production; change `AMM_API_BASE_URL` to
`https://dev.aftermarketmovers.com` for development.

## Native authentication

- The application URL scheme and Clerk mobile SSO redirect must both be
  `com.evolo.amm://callback`.
- Keep that redirect allowlisted in the production AMM Clerk instance under
  **Configure → Developers → Native applications**. The development service
  deliberately uses the shared production Clerk identities.
- After changing the generated Info.plist properties, run `xcodegen generate`
  before building. A release check must complete one Google sign-in and prove
  that the browser returns to AMM.

## Voice contract

- Pro: 15 minutes per day.
- Ultra: 60 minutes per day.
- The iOS client receives a short-lived OpenAI Realtime credential. The
  standard key remains in Cloud Run.
- Every substantive question must call the closed AMM company-file tool.
- Typed questions use the same authenticated, source-bound company-file
  contract as live voice. They never launch a second council or open-web
  search.
- The app can show retrieval and verification progress immediately, but it
  reveals facts and citations only after the server source gate succeeds.
- Raw audio is not stored. Server leases and heartbeats enforce quota even if
  the app is interrupted.
- An active call continues while the screen is locked or AMM is backgrounded.
  Leaving the company screen or tapping End closes both media and server lease.

## Release checks

1. Decode the live `/api/mobile/v1/desk` fixture.
2. Sign in with Clerk and open the same Desk as the web app.
3. Grant microphone permission and start a live session.
4. Confirm a cited thesis question shows verified source cards before speech.
5. Ask an out-of-file question and confirm the closed-boundary response.
6. Ask for buy/sell advice and confirm the research-only refusal.
7. Interrupt the spoken answer and ask a follow-up.
8. Lock the screen and confirm the audio conversation and metering continue.
9. Leave the company screen and confirm the media connection and lease end.
10. Confirm a second concurrent session is rejected.
11. Create a first Desk natively and confirm an unsupported symbol is rejected
    before a company slot is consumed.
12. Disable the network, relaunch, and confirm the last verified Desk remains
    readable with the offline receipt and retry action.
