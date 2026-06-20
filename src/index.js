/**
 * discourse-to-ghost
 *
 * Cloudflare Worker that listens for Discourse webhooks and creates a
 * Ghost draft post whenever a topic is tagged "publish".
 *
 * Flow:
 *   1. Discourse fires a webhook on post/topic events.
 *   2. We verify the request signature (X-Discourse-Event-Signature).
 *   3. We check whether the topic's tag list includes PUBLISH_TAG.
 *   4. We check Workers KV to see if this topic has already been synced.
 *   5. If new, fetch the full topic from the Discourse API, convert it,
 *      and POST it to Ghost as a draft via the Admin API.
 *   6. Record the topic ID in KV so re-edits don't create duplicates.
 *
 * Required secrets (set via `wrangler secret put <NAME>`):
 *   - DISCOURSE_WEBHOOK_SECRET   shared secret configured in Discourse webhook
 *   - DISCOURSE_API_KEY          Discourse API key (read-only scope is enough)
 *   - DISCOURSE_API_USERNAME     (optional) Discourse username for API requests, defaults to "system"
 *   - GHOST_ADMIN_API_KEY        Ghost Admin API key, format "id:secret"
 *
 * Required vars (set in wrangler.toml [vars]):
 *   - DISCOURSE_BASE_URL   e.g. "https://forum.0x00sec.org"
 *   - GHOST_BASE_URL       e.g. "https://0x00sec.org"
 *   - PUBLISH_TAG          e.g. "publish"
 *
 * Required bindings (set in wrangler.toml):
 *   - SYNCED_TOPICS  (Workers KV namespace)
 */

import { verifyDiscourseSignature } from "./verifySignature.js";
import { fetchTopic } from "./discourse.js";
import { discourseTopicToGhostPost } from "./convert.js";
import { createGhostDraft } from "./ghost.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/discourse-hook") {
      return new Response("Not found", { status: 404 });
    }

    // Discourse signs the raw body, so we need it before any JSON parsing.
    const rawBody = await request.text();

    const signature = request.headers.get("X-Discourse-Event-Signature");
    const signatureOk = await verifyDiscourseSignature(
      rawBody,
      signature,
      env.DISCOURSE_WEBHOOK_SECRET
    );

    if (!signatureOk) {
      // Don't leak details about why verification failed.
      return new Response("Invalid signature", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      return new Response("Bad JSON", { status: 400 });
    }

    // Discourse webhook payloads vary by event type:
    //   - topic events have payload.topic (with tags)
    //   - post events have payload.post (with topic_id but no tags)
    const topicId =
      payload.topic?.id ?? payload.post?.topic_id ?? payload.post?.topic?.id;
    if (!topicId) {
      return new Response("Ignored: no topic in payload", { status: 200 });
    }

    // Idempotency check — has this topic already been synced to Ghost?
    const kvKey = `topic:${topicId}`;
    const alreadySynced = await env.SYNCED_TOPICS.get(kvKey);
    if (alreadySynced) {
      return new Response(
        `Ignored: topic ${topicId} already synced (ghost post ${alreadySynced})`,
        { status: 200 }
      );
    }

    try {
      // Always fetch the full topic from the API — webhook payloads don't
      // reliably include tags or the rendered body.
      const topic = await fetchTopic({
        baseUrl: env.DISCOURSE_BASE_URL,
        topicId,
        apiKey: env.DISCOURSE_API_KEY,
        apiUsername: env.DISCOURSE_API_USERNAME || "system",
      });

      const publishTag = env.PUBLISH_TAG || "publish";
      const tags = (topic.tags ?? []).map((t) =>
        typeof t === "string" ? t : t.name
      );
      if (!tags.includes(publishTag)) {
        return new Response("Ignored: not tagged for publishing", {
          status: 200,
        });
      }

      const ghostPostPayload = discourseTopicToGhostPost(topic, {
        discourseBaseUrl: env.DISCOURSE_BASE_URL,
      });

      const ghostPost = await createGhostDraft({
        baseUrl: env.GHOST_BASE_URL,
        adminApiKey: env.GHOST_ADMIN_API_KEY,
        post: ghostPostPayload,
      });

      // Remember it so we don't duplicate on future edits/re-tags.
      await env.SYNCED_TOPICS.put(kvKey, ghostPost.id, {
        // Keep forever; remove this if you want KV to expire entries.
      });

      return new Response(
        `OK: created Ghost draft ${ghostPost.id} for topic ${topicId}`,
        { status: 200 }
      );
    } catch (err) {
      console.error("Sync failed:", err);
      // Return 500 so Discourse's webhook delivery log shows the failure
      // and (depending on Discourse settings) may retry.
      return new Response(`Sync failed: ${err.message}`, { status: 500 });
    }
  },
};
