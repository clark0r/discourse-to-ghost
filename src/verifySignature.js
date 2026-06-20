/**
 * Discourse signs webhook payloads with HMAC-SHA256 over the raw request
 * body, sent as `X-Discourse-Event-Signature: sha256=<hex>`.
 *
 * Docs: https://meta.discourse.org/t/setting-up-webhooks/49045
 */

export async function verifyDiscourseSignature(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;

  const expectedPrefix = "sha256=";
  if (!headerValue.startsWith(expectedPrefix)) return false;

  const providedHex = headerValue.slice(expectedPrefix.length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );

  const computedHex = bufferToHex(signatureBuffer);

  return timingSafeEqual(computedHex, providedHex);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Plain === on strings can leak timing info character-by-character.
// This is a simple constant-time-ish comparison sufficient for our purposes.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
