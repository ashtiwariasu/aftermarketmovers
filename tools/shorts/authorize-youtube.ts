#!/usr/bin/env tsx
/**
 * One-time operator flow. Run locally with a Google OAuth "Desktop app" client:
 *
 * YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... \
 *   npx tsx tools/shorts/authorize-youtube.ts
 *
 * The browser returns to a loopback listener. The refresh token is validated
 * against the expected channel and written straight to Secret Manager; it is
 * never printed or saved to a repo file.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clientId = process.env.YOUTUBE_CLIENT_ID ?? "";
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? "";
const expectedChannel = process.env.YOUTUBE_CHANNEL_ID ?? "";
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
if (!projectId) throw new Error("Set GOOGLE_CLOUD_PROJECT to the project that holds the YouTube secrets.");
const secretName = process.env.YOUTUBE_REFRESH_TOKEN_SECRET ?? "amm-youtube-refresh-token";
const port = Number(process.env.YOUTUBE_OAUTH_PORT ?? "53682");
const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;

if (!clientId || !clientSecret) {
  throw new Error("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required");
}

async function addSecretVersion(refreshToken: string): Promise<void> {
  try {
    await execFileAsync("gcloud", [
      "secrets", "describe", secretName, "--project", projectId,
    ]);
  } catch {
    await execFileAsync("gcloud", [
      "secrets", "create", secretName,
      "--project", projectId,
      "--replication-policy", "automatic",
    ]);
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "gcloud",
      ["secrets", "versions", "add", secretName, "--project", projectId, "--data-file=-"],
      (error) => error ? reject(error) : resolve(),
    );
    child.stdin?.end(refreshToken);
  });
}

const authorizationUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

console.log("Open this URL in the Google account that owns AI and Ash:");
console.log(authorizationUrl);
console.log(`Waiting on ${redirectUri}`);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", redirectUri);
  if (url.pathname !== "/oauth2/callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (!code || oauthError) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end(`YouTube authorization failed: ${oauthError ?? "missing code"}`);
    server.close();
    return;
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
      throw new Error(
        token.error_description ??
        "Google returned no refresh token; revoke the prior grant and run the consent flow again",
      );
    }
    const channelResponse = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
      { headers: { authorization: `Bearer ${token.access_token}` } },
    );
    const channel = await channelResponse.json() as {
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
    };
    const item = channel.items?.[0];
    if (!channelResponse.ok || item?.id !== expectedChannel) {
      throw new Error(
        `authorized the wrong YouTube channel: expected ${expectedChannel}, received ${item?.id ?? "none"}`,
      );
    }
    await addSecretVersion(token.refresh_token);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(
      `Connected ${item.snippet?.title ?? expectedChannel}. ` +
      "The refresh token is stored in Secret Manager; you can close this tab.",
    );
    console.log(`Connected ${item.snippet?.title ?? expectedChannel}; stored ${secretName}`);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`YouTube authorization failed: ${String(error)}`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1");
