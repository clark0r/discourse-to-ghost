/**
 * Twitter/X client for posting tweets via API v2.
 *
 * Requires OAuth 1.0a user-context credentials (not bearer token).
 * Create these at: https://developer.x.com/en/portal/dashboard
 *
 * Required env vars:
 *   TWITTER_API_KEY             Consumer / API key
 *   TWITTER_API_SECRET          Consumer / API secret
 *   TWITTER_ACCESS_TOKEN        Access token (your account)
 *   TWITTER_ACCESS_TOKEN_SECRET Access token secret
 */

const TWEET_URL = "https://api.twitter.com/2/tweets";

export async function postToTwitter({
  apiKey,
  apiSecret,
  accessToken,
  accessTokenSecret,
  topic,
  postUrl,
  hashtags,
}) {
  const authorDisplay = topic.author.name || topic.author.username;
  const hashtagLine = hashtags.map((t) => `#${t}`).join(" ");
  const text = `"${topic.title}" by ${authorDisplay}\n\n${hashtagLine}\n\n${postUrl}`;

  const body = JSON.stringify({ text });
  const authHeader = await buildOAuthHeader(
    "POST",
    TWEET_URL,
    apiKey,
    apiSecret,
    accessToken,
    accessTokenSecret
  );

  const res = await fetch(TWEET_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body,
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(
      `Twitter API error: ${res.status} ${res.statusText} — ${bodyText}`
    );
  }

  return await res.json();
}

async function buildOAuthHeader(
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret
) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: "1.0",
  };

  const signature = await computeSignature(
    method,
    url,
    oauthParams,
    consumerSecret,
    tokenSecret
  );

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerParts = Object.entries(headerParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

async function computeSignature(
  method,
  url,
  oauthParams,
  consumerSecret,
  tokenSecret
) {
  const allParams = { ...oauthParams };
  const sortedParams = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join("&");

  const baseString = [method.toUpperCase(), pct(url), pct(sortedParams)].join(
    "&"
  );

  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;

  const keyData = new TextEncoder().encode(signingKey);
  const msgData = new TextEncoder().encode(baseString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function pct(str) {
  return encodeURIComponent(str);
}
