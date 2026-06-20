/**
 * Minimal Discourse API client — just enough to fetch a topic's first post
 * in raw Markdown form, plus title/slug/tags/author for the Ghost post.
 *
 * Discourse API docs: https://docs.discourse.org/
 */

export async function fetchTopic({ baseUrl, topicId, apiKey, apiUsername }) {
  const url = `${baseUrl.replace(/\/$/, "")}/t/${topicId}.json`;

  const res = await fetch(url, {
    headers: {
      "Api-Key": apiKey,
      "Api-Username": apiUsername,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Discourse API error fetching topic ${topicId}: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();

  const firstPost = data.post_stream?.posts?.[0];
  if (!firstPost) {
    throw new Error(`Topic ${topicId} has no posts in post_stream`);
  }

  return {
    id: data.id,
    title: data.title,
    slug: data.slug,
    tags: (data.tags ?? []).map((t) => (typeof t === "string" ? t : t.name)),
    createdAt: data.created_at,
    author: {
      username: firstPost.username,
      name: firstPost.name,
    },
    raw: firstPost.raw ?? null,
    cookedHtml: firstPost.cooked ?? null,
    topicUrl: `${baseUrl.replace(/\/$/, "")}/t/${data.slug}/${data.id}`,
  };
}
