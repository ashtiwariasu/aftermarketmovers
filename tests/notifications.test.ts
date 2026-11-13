import assert from "node:assert/strict";
import test from "node:test";
import {
  publicResearchContentIssues,
  researchDeliveryIssues,
  sendEmail,
  sendRenewalSummaryEmail,
} from "../src/lib/notifications";

const headers = {
  "List-Unsubscribe": "<https://aftermarketmovers.com/api/email/unsub?d=desk&t=token>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

const safeText = [
  "Independent factual market research. Not financial, investment, tax or legal advice.",
  "Evolo Pty Ltd · 123 Test Street, Brisbane QLD 4000, Australia",
  "Unsubscribe: https://aftermarketmovers.com/api/email/unsub?d=desk&t=token",
].join("\n");

test("public-copy gate blocks recommendations, targets and percentage forecasts", () => {
  assert.ok(
    publicResearchContentIssues({ subject: "AMM", text: "Readers should buy it.", html: "" })
      .some((i) => i.startsWith("recommendation language")),
  );
  assert.deepEqual(
    publicResearchContentIssues({ subject: "AMM", text: "The price target is $140.", html: "" }),
    ["price target"],
  );
  assert.ok(
    publicResearchContentIssues({ subject: "AMM", text: "The expected upside is 8% over two weeks.", html: "" })
      .some((i) => i.startsWith("percentage forecast")),
  );
  for (const text of [
    "The analyst recommends accumulating the shares.",
    "The desk rated the stock underweight.",
    "Readers could hold this position.",
    "The company was a strong-buy candidate.",

    "Maintain a Hold rating.",
    "The recommendation remains Hold.",
    "Avoid GOOGL.",
    "Exit GOOGL.",
    "Reduce GOOGL exposure.",
    "This is a conviction long.",
  ]) {
    assert.ok(
      publicResearchContentIssues({ subject: "AMM", text, html: "" })
        .some((i) => i.startsWith("recommendation language")),
      text,
    );
  }
  for (const text of [
    "Heavy selling pressure hit the tape after the print.",
    "The company bought back $70 billion of stock.",
    "Insider selling accelerated in June.",
    "A broad sell-off dragged the index lower.",
    "The cloud segment outperformed peers.",
    "The stock's underperformance narrowed.",
    "Advertisers are buying more inventory.",
    "The 81% net-income surge cannot be judged fully repeatable and may prove partly durable.",
  ]) {
    assert.deepEqual(
      publicResearchContentIssues({ subject: "AMM", text, html: "" }),
      [],
      text,
    );
  }
  for (const text of [
    "The stock is a buy at these levels.",
    "It is time to sell.",
    "Investors might consider selling into strength.",
    "Sell GOOGL.",
  ]) {
    assert.ok(
      publicResearchContentIssues({ subject: "AMM", text, html: "" })
        .some((i) => i.startsWith("recommendation language")),
      text,
    );
  }
  for (const text of [
    "Shares could climb 3–10% over the next 15 sessions.",
    "A 4% move is possible within two weeks.",
    "The expected move over the next month is between 3 and 8 percent.",
    "The thesis points to downside of roughly 6 percent.",
    "Over the next 10 trading sessions, the shares may rise 5%.",
    "This can support the price up around 3-10% for 2-3 weeks.",
    "The setup offers 8% upside.",
    "The stock is projected to rise five percent over two weeks.",
    "The stock may gain five per cent in 15 sessions.",
    "The expected move is eight pct over 10 sessions.",
  ]) {
    assert.ok(
      publicResearchContentIssues({ subject: "AMM", text, html: "" })
        .some((i) => i.startsWith("percentage forecast")),
      text,
    );
  }
  assert.deepEqual(
    publicResearchContentIssues({ subject: "AMM", text: "Revenue rose 22% last quarter.", html: "" }),
    [],
  );
  assert.deepEqual(
    publicResearchContentIssues({ subject: "AMM", text: "Revenue rose five percent last quarter.", html: "" }),
    [],
  );
  for (const text of [
    "The price objective is $140.",
    "Our valuation is $140 per share.",
    "$140/share is the desk's valuation.",
  ]) {
    assert.deepEqual(
      publicResearchContentIssues({ subject: "AMM", text, html: "" }),
      ["price target"],
      text,
    );
  }
});

test("research delivery requires compliance footer and one-click unsubscribe", () => {
  const previous = process.env.COMPANY_POSTAL_ADDRESS;
  const previousSecret = process.env.UNSUBSCRIBE_SECRET;
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  try {
    assert.deepEqual(
      researchDeliveryIssues({
        subject: "AMM morning thesis",
        text: safeText,
        html: `<p>${safeText}</p>`,
        headers,
      }),
      [],
    );
    delete process.env.COMPANY_POSTAL_ADDRESS;
    assert.match(
      researchDeliveryIssues({ subject: "AMM", text: safeText, html: safeText, headers }).join(","),
      /COMPANY_POSTAL_ADDRESS missing/,
    );
  } finally {
    if (previous == null) delete process.env.COMPANY_POSTAL_ADDRESS;
    else process.env.COMPANY_POSTAL_ADDRESS = previous;
    if (previousSecret == null) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = previousSecret;
  }
});

test("gated research delivery passes compliant payload and headers to Resend", async () => {
  const previous = {
    enabled: process.env.AMM_EMAILS_ENABLED,
    key: process.env.RESEND_API_KEY,
    address: process.env.COMPANY_POSTAL_ADDRESS,
    sink: process.env.EMAIL_SINK_OVERRIDE,
    secret: process.env.UNSUBSCRIBE_SECRET,
    emailFrom: process.env.EMAIL_FROM,
    noteFrom: process.env.NOTE_FROM,
    fetch: globalThis.fetch,
  };
  process.env.AMM_EMAILS_ENABLED = "true";
  process.env.RESEND_API_KEY = "test-key";
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  delete process.env.EMAIL_FROM;
  process.env.NOTE_FROM = "AMM Test <note@example.com>";
  delete process.env.EMAIL_SINK_OVERRIDE;
  let payload: Record<string, unknown> | null = null;
  let requestHeaders: HeadersInit | undefined;
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestHeaders = init?.headers;
    return new Response("{}", { status: 200 });
  };
  try {
    const ok = await sendEmail({
      to: "reader@example.com",
      subject: "AMM morning thesis",
      text: safeText,
      html: `<p>${safeText}</p>`,
      headers,
      kind: "research",
      idempotencyKey: "amm-note-stable-test-key",
    });
    assert.equal(ok, true);
    assert.ok(payload);
    assert.deepEqual((payload as Record<string, unknown>).headers, headers);
    assert.equal((payload as Record<string, unknown>).from, "AMM Test <note@example.com>");
    assert.equal(new Headers(requestHeaders).get("Idempotency-Key"), "amm-note-stable-test-key");
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["AMM_EMAILS_ENABLED", previous.enabled],
      ["RESEND_API_KEY", previous.key],
      ["COMPANY_POSTAL_ADDRESS", previous.address],
      ["EMAIL_SINK_OVERRIDE", previous.sink],
      ["UNSUBSCRIBE_SECRET", previous.secret],
      ["EMAIL_FROM", previous.emailFrom],
      ["NOTE_FROM", previous.noteFrom],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("research delivery fails closed before Resend when address is missing", async () => {
  const previous = {
    enabled: process.env.AMM_EMAILS_ENABLED,
    key: process.env.RESEND_API_KEY,
    address: process.env.COMPANY_POSTAL_ADDRESS,
    secret: process.env.UNSUBSCRIBE_SECRET,
    fetch: globalThis.fetch,
  };
  process.env.AMM_EMAILS_ENABLED = "true";
  process.env.RESEND_API_KEY = "test-key";
  delete process.env.COMPANY_POSTAL_ADDRESS;
  process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  try {
    const ok = await sendEmail({
      to: "reader@example.com",
      subject: "AMM morning thesis",
      text: safeText,
      html: `<p>${safeText}</p>`,
      headers,
      kind: "research",
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.enabled == null) delete process.env.AMM_EMAILS_ENABLED;
    else process.env.AMM_EMAILS_ENABLED = previous.enabled;
    if (previous.key == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous.key;
    if (previous.address == null) delete process.env.COMPANY_POSTAL_ADDRESS;
    else process.env.COMPANY_POSTAL_ADDRESS = previous.address;
    if (previous.secret == null) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = previous.secret;
  }
});

test("an omitted kind defaults to the research gate, never ungated delivery", async () => {
  const previous = {
    enabled: process.env.AMM_EMAILS_ENABLED,
    key: process.env.RESEND_API_KEY,
    address: process.env.COMPANY_POSTAL_ADDRESS,
    secret: process.env.UNSUBSCRIBE_SECRET,
    fetch: globalThis.fetch,
  };
  process.env.AMM_EMAILS_ENABLED = "true";
  process.env.RESEND_API_KEY = "test-key";
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  try {
    const ok = await sendEmail({
      to: "reader@example.com",
      subject: "Buy now",
      text: safeText,
      html: `<p>${safeText}</p>`,
      headers,
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["AMM_EMAILS_ENABLED", previous.enabled],
      ["RESEND_API_KEY", previous.key],
      ["COMPANY_POSTAL_ADDRESS", previous.address],
      ["UNSUBSCRIBE_SECRET", previous.secret],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("transactional renewal mail stays non-promotional and carries legal identity", async () => {
  const previous = {
    enabled: process.env.AMM_EMAILS_ENABLED,
    key: process.env.RESEND_API_KEY,
    address: process.env.COMPANY_POSTAL_ADDRESS,
    fetch: globalThis.fetch,
  };
  process.env.AMM_EMAILS_ENABLED = "true";
  process.env.RESEND_API_KEY = "test-key";
  process.env.COMPANY_POSTAL_ADDRESS = "123 Test Street, Brisbane QLD 4000, Australia";
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("{}", { status: 200 });
  };
  try {
    assert.equal(await sendRenewalSummaryEmail("reader@example.com", {
      sittings: 27,
      companies: 9,
      renewsAt: "2026-08-01",
    }), true);
    const delivered = String((payload as unknown as Record<string, unknown>)?.text ?? "");
    assert.match(delivered, /Evolo Pty Ltd · 123 Test Street/);
    assert.doesNotMatch(delivered, /27 council sittings|9 company files|full audited council|daily dossiers/i);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.enabled == null) delete process.env.AMM_EMAILS_ENABLED;
    else process.env.AMM_EMAILS_ENABLED = previous.enabled;
    if (previous.key == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous.key;
    if (previous.address == null) delete process.env.COMPANY_POSTAL_ADDRESS;
    else process.env.COMPANY_POSTAL_ADDRESS = previous.address;
  }
});


test("historical percentages are facts, not forecasts", () => {
  for (const text of [
    "Net income rose 81% in the quarter. [S3]",
    "Alphabet's one-month performance was -5.03% over 21 sessions.",
    "Shares fell 4.4% on the day and 0.04% after hours.",
    "Revenue grew 14% year over year per the filing. [S2]",
    "Cloud operating income increased 203% in the filed period. [S4]",
  ]) {
    assert.deepEqual(
      publicResearchContentIssues({ subject: "x", text }),
      [],
      `false positive: ${text}`
    );
  }
});

test("future percentages remain blocked", () => {
  for (const text of [
    "We expect the stock to gain 5% next month.",
    "Modelled -3.2% to -6.4% over the next 2-3 weeks.",
    "The shares will likely decline 4% within the coming 10 sessions.",
    "Points to 8% upside in the next quarter.",
  ]) {
    assert.ok(
      publicResearchContentIssues({ subject: "x", text }).some((i) => i.startsWith("percentage forecast")),
      `missed forecast: ${text}`
    );
  }
});
