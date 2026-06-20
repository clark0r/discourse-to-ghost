/**
 * Converts a fetched Discourse topic into the payload shape expected by
 * the Ghost Admin API's POST /posts/ endpoint.
 *
 * Ghost's Admin API accepts a post body as either:
 *   - `html`        raw HTML (Ghost will store it in a single HTML card)
 *   - `mobiledoc`    Ghost's native rich content format (JSON)
 *
 * We use `html` here rather than hand-building mobiledoc. It's far less
 * code, Ghost renders it fine inside a single HTML card, and it avoids
 * having to reimplement Ghost's card schema. The tradeoff: editors won't
 * get fully native Ghost cards (e.g. a real "code card") — everything
 * lands as one HTML block they can still edit by hand afterward, which
 * is appropriate for a draft pending human review.
 *
 * Code block handling: Discourse stores raw Markdown with standard
 * ```lang fenced blocks. We convert those to <pre><code> manually rather
 * than pulling in a full Markdown library, to keep the Worker small and
 * dependency-free. This is intentionally a light Markdown subset, not a
 * general-purpose renderer.
 */

export function discourseTopicToGhostPost(topic, { discourseBaseUrl }) {
  const html = topic.raw
    ? markdownToHtml(topic.raw)
    : topic.cookedHtml ?? "";

  const attributionFooter = `
    <hr>
    <p><em>Original post by
      <a href="${discourseBaseUrl}/u/${escapeHtml(topic.author.username)}">${escapeHtml(
    topic.author.name || topic.author.username
  )}</a>,
      from the <a href="${escapeHtml(topic.topicUrl)}">0x00sec forum</a>.</em></p>
  `.trim();

  return {
    title: topic.title,
    html: `${html}\n${attributionFooter}`,
    status: "draft",
    tags: [...topic.tags, "from-forum"],
    custom_excerpt: undefined, // let Ghost auto-generate; set manually if you want
    meta_title: topic.title,
    codeinjection_head: undefined,
  };
}

/**
 * Lightweight Markdown -> HTML conversion covering the subset Discourse
 * posts commonly use: fenced code blocks, inline code, headings, bold,
 * italics, links, and paragraphs. NOT a full CommonMark implementation.
 *
 * If 0x00sec's posts start leaning on features this misses (tables,
 * nested lists, Discourse-specific BBCode-like extensions, polls,
 * oneboxes), swap this out for a proper library — `markdown-it` works
 * fine in Workers since it's pure JS with no Node-only APIs.
 */
function markdownToHtml(markdown) {
  const codeBlocks = [];

  // Pull out fenced code blocks first and replace with placeholders so
  // the rest of the conversion doesn't mangle their contents.
  let working = markdown.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const index = codeBlocks.length;
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      codeBlocks.push(
        `<pre><code${langClass}>${escapeHtml(code.trimEnd())}</code></pre>`
      );
      return `\u0000CODEBLOCK${index}\u0000`;
    }
  );

  // Inline code
  working = working.replace(/`([^`]+)`/g, (_m, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Headings (## -> h2, ### -> h3, etc. up to h6)
  working = working.replace(/^(#{1,6})\s+(.*)$/gm, (_m, hashes, text) => {
    const level = hashes.length;
    return `<h${level}>${inlineFormat(text)}</h${level}>`;
  });

  // Bold and italics (do bold before italics so **x** isn't caught by *x*)
  working = working.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links [text](url)
  working = working.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text, url) => `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`
  );

  // Paragraphs: split on blank lines, wrap remaining plain-text lines.
  // Skip lines that are already block-level HTML (headings, placeholders).
  const blocks = working
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^\u0000CODEBLOCK\d+\u0000$/.test(block)) return block;
      if (/^<h[1-6]>/.test(block)) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    });

  let html = blocks.join("\n");

  // Re-insert code blocks.
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i) => {
    return codeBlocks[Number(i)];
  });

  return html;
}

function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
