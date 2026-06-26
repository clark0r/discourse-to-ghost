/**
 * discourse-to-ghost
 *
 * Cloudflare Worker that listens for Discourse webhooks and creates a
 * Ghost post whenever a topic is tagged "publish".
 *
 * Flow:
 *   1. Discourse fires a webhook on post/topic events.
 *   2. We verify the request signature (X-Discourse-Event-Signature).
 *   3. We check whether the topic's tag list includes PUBLISH_TAG.
 *   4. We check Workers KV to see if this topic has already been synced.
 *   5. If new, fetch the full topic from the Discourse API, convert it,
 *      and POST it to Ghost via the Admin API.
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
import { createGhostPost } from "./ghost.js";
import { postToBluesky } from "./bluesky.js";
import { postToTwitter } from "./twitter.js";
import { postToDiscord } from "./discord.js";

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

      // Announce all new topics to Discord regardless of publish tag,
      // but skip system messages (e.g. welcome topics, automated notices).
    const discourseEvent = request.headers.get("X-Discourse-Event");
    let discordResult = null;
    const isRegularTopic = topic.archetype === "regular";
    const isSystemMessage = topic.author?.username === "system";
    if (discourseEvent === "topic_created" && env.DISCORD_WEBHOOK_URL && isRegularTopic && !isSystemMessage) {
      try {
        discordResult = await postToDiscord({
          webhookUrl: env.DISCORD_WEBHOOK_URL,
          topic,
          notifRoleId: env.DISCORD_NOTIF_ROLE_ID,
        });
      } catch (discordErr) {
        console.error("Discord announcement failed (non-fatal):", discordErr);
      }
    }

    const publishTag = env.PUBLISH_TAG || "publish";
      const tags = (topic.tags ?? []).map((t) =>
        typeof t === "string" ? t : t.name
      );
      if (!tags.includes(publishTag)) {
        const discordNote = discordResult ? " (Discord announced)" : "";
        return new Response(`Ignored: not tagged for publishing${discordNote}`, {
          status: 200,
        });
      }

      const ghostPostPayload = discourseTopicToGhostPost(topic, {
        discourseBaseUrl: env.DISCOURSE_BASE_URL,
      });

      const ghostPost = await createGhostPost({
        baseUrl: env.GHOST_BASE_URL,
        adminApiKey: env.GHOST_ADMIN_API_KEY,
        post: ghostPostPayload,
      });

      // Remember it so we don't duplicate on future edits/re-tags.
      await env.SYNCED_TOPICS.put(kvKey, ghostPost.id, {
        // Keep forever; remove this if you want KV to expire entries.
      });

      // Post to Bluesky if credentials are configured.
      // Failures here are logged but don't fail the webhook — the Ghost
      // post (the primary action) already succeeded.
      const postUrl = ghostPost.url || `${env.GHOST_BASE_URL}/${ghostPost.slug}/`;
      const socialHashtags = (env.SOCIAL_HASHTAGS || "infosec,cybersec,hacking")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      let bskyResult = null;
      if (env.BLUESKY_IDENTIFIER && env.BLUESKY_APP_PASSWORD) {
        try {
          bskyResult = await postToBluesky({
            identifier: env.BLUESKY_IDENTIFIER,
            appPassword: env.BLUESKY_APP_PASSWORD,
            serviceUrl: env.BLUESKY_SERVICE_URL,
            topic,
            postUrl,
            hashtags: socialHashtags,
          });
        } catch (bskyErr) {
          console.error("Bluesky post failed (non-fatal):", bskyErr);
        }
      }

      // Post to Twitter/X if credentials are configured.
      let twitterResult = null;
      if (
        env.TWITTER_API_KEY &&
        env.TWITTER_API_SECRET &&
        env.TWITTER_ACCESS_TOKEN &&
        env.TWITTER_ACCESS_TOKEN_SECRET
      ) {
        try {
          twitterResult = await postToTwitter({
            apiKey: env.TWITTER_API_KEY,
            apiSecret: env.TWITTER_API_SECRET,
            accessToken: env.TWITTER_ACCESS_TOKEN,
            accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
            topic,
            postUrl,
            hashtags: socialHashtags,
          });
        } catch (twitterErr) {
          console.error("Twitter post failed (non-fatal):", twitterErr);
        }
      }

      const discordMsg = discordResult
        ? ", Discord announced"
        : env.DISCORD_WEBHOOK_URL && discourseEvent === "topic_created"
          ? ", Discord announcement failed (see logs)"
          : "";

      const bskyMsg = bskyResult
        ? `, Bluesky post ${bskyResult.uri}`
        : env.BLUESKY_IDENTIFIER
          ? ", Bluesky post failed (see logs)"
          : "";

      const twitterMsg = twitterResult
        ? `, Twitter post ${twitterResult.data?.id}`
        : env.TWITTER_API_KEY
          ? ", Twitter post failed (see logs)"
          : "";

      return new Response(
        `OK: published Ghost post ${ghostPost.id} for topic ${topicId}${discordMsg}${bskyMsg}${twitterMsg}`,
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
