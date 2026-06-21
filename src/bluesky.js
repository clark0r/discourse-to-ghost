/**
 * Bluesky (AT Protocol) client for posting to Bluesky.
 *
 * Uses app passwords (not main account password) for authentication.
 * Create one at: https://bsky.app/settings/app-passwords
 *
 * AT Protocol docs: https://docs.bsky.app/
 */

const DEFAULT_SERVICE_URL = "https://bsky.social";

export async function postToBluesky({
  identifier,
  appPassword,
  serviceUrl,
  topic,
  postUrl,
  hashtags,
}) {
  const service = (serviceUrl || DEFAULT_SERVICE_URL).replace(/\/$/, "");

  const session = await createSession(service, identifier, appPassword);

  const authorDisplay = topic.author.name || topic.author.username;
  const hashtagLine = hashtags.map((t) => `#${t}`).join(" ");
  const text = `"${topic.title}" by ${authorDisplay}\n\n${hashtagLine}`;

  const facets = buildHashtagFacets(text, hashtags);

  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    facets,
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: postUrl,
        title: topic.title,
        description: `By ${authorDisplay} — from the 0x00sec forum`,
      },
    },
  };

  const res = await fetch(
    `${service}/xrpc/com.atproto.repo.createRecord`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Bluesky API error creating post: ${res.status} ${res.statusText} — ${body}`
    );
  }

  return await res.json();
}

async function createSession(serviceUrl, identifier, password) {
  const res = await fetch(
    `${serviceUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Bluesky login failed: ${res.status} ${res.statusText} — ${body}`
    );
  }

  return await res.json();
}

/**
 * Builds AT Protocol facets for hashtags. Facets use byte offsets into
 * the UTF-8 encoded text, not character indices.
 */
function buildHashtagFacets(text, hashtags) {
  const encoder = new TextEncoder();
  const facets = [];

  for (const tag of hashtags) {
    const needle = `#${tag}`;
    const idx = text.indexOf(needle);
    if (idx === -1) continue;

    const byteStart = encoder.encode(text.slice(0, idx)).byteLength;
    const byteEnd = byteStart + encoder.encode(needle).byteLength;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets;
}
