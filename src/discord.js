/**
 * Discord webhook client for announcing new Discourse topics.
 *
 * Create a webhook in your Discord channel:
 * Channel Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL
 *
 * Set DISCORD_WEBHOOK_URL to that URL in your worker secrets.
 */

export async function postToDiscord({ webhookUrl, topic, notifRoleId }) {
  const author = topic.author.name || topic.author.username;
  const excerpt = buildExcerpt(topic.raw);

  const embed = {
    title: topic.title,
    url: topic.topicUrl,
    color: 0x36a6a0,
    author: {
      name: author,
      ...(topic.author.avatarUrl && { icon_url: topic.author.avatarUrl }),
    },
    timestamp: topic.createdAt ?? new Date().toISOString(),
    footer: { text: "To unsubscribe from these notifications, head to #roles and react 👎" },
  };

  if (excerpt) embed.description = excerpt;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: notifRoleId ? `<@&${notifRoleId}>` : undefined,
      embeds: [embed],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Discord webhook error: ${res.status} ${res.statusText} — ${body}`
    );
  }

  return { ok: true };
}

function buildExcerpt(raw, maxLength = 280) {
  if (!raw) return null;

  const text = raw
    .replace(/```[\s\S]*?```/g, "")          // fenced code blocks
    .replace(/`[^`\n]+`/g, "")               // inline code
    .replace(/!\[.*?\]\(.*?\)/g, "")         // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [link text](url) → text
    .replace(/^#{1,6}\s+/gm, "")             // headings
    .replace(/^[-*_]{3,}\s*$/gm, "")         // horizontal rules
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) return null;
  if (text.length <= maxLength) return text;

  // Prefer cutting at the end of a sentence within the allowed length.
  const window = text.slice(0, maxLength);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? ")
  );
  const breakAt =
    sentenceEnd > maxLength * 0.55
      ? sentenceEnd + 1
      : window.lastIndexOf(" ");

  return text.slice(0, breakAt > 0 ? breakAt : maxLength).trimEnd() + "…";
}
