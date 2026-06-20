/**
 * Ghost Admin API client.
 *
 * Ghost Admin API auth uses a short-lived JWT, signed with the secret half
 * of your Admin API Key (format "id:secret", from Ghost Admin ->
 * Integrations -> "Add custom integration").
 *
 * JWT requirements per Ghost docs:
 *   - header: { alg: "HS256", typ: "JWT", kid: <key id> }
 *   - payload: { iat, exp (max 5 min ahead), aud: "/admin/" }
 *   - signed with HMAC-SHA256 using the hex-decoded secret
 *
 * Docs: https://ghost.org/docs/admin-api/#token-authentication
 */

export async function createGhostDraft({ baseUrl, adminApiKey, post }) {
  const token = await signGhostJwt(adminApiKey);

  const url = `${baseUrl.replace(/\/$/, "")}/ghost/api/admin/posts/?source=html`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Ghost ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ posts: [post] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Ghost API error creating post: ${res.status} ${res.statusText} — ${body}`
    );
  }

  const data = await res.json();
  return data.posts[0];
}

async function signGhostJwt(adminApiKey) {
  const [id, secretHex] = adminApiKey.split(":");
  if (!id || !secretHex) {
    throw new Error(
      'GHOST_ADMIN_API_KEY must be in "id:secret" format, as shown in Ghost Admin -> Integrations'
    );
  }

  const header = { alg: "HS256", typ: "JWT", kid: id };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iat: nowSeconds,
    exp: nowSeconds + 5 * 60, // Ghost caps this at 5 minutes
    aud: "/admin/",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const secretBytes = hexToBytes(secretHex);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(
    new Uint8Array(signatureBuffer)
  );

  return `${signingInput}.${encodedSignature}`;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function base64UrlEncode(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
