# discourse-to-ghost

Cloudflare Worker that watches for Discourse topics tagged `publish` and
creates a matching Ghost **draft** post automatically.

Nothing ever auto-publishes — every synced topic lands in Ghost as a draft
for a human to review, format, and hit Publish on.

---

## How it works

1. You tag a Discourse topic with `publish`.
2. Discourse fires a webhook to this Worker.
3. The Worker verifies the webhook signature, checks the tag, and checks
   Workers KV to make sure this topic hasn't already been synced.
4. If it's new, the Worker fetches the full topic from the Discourse API,
   converts the Markdown body to HTML, and creates a draft post in Ghost
   via the Admin API.
5. The topic ID is recorded in KV so editing the topic later (which
   re-fires the webhook) won't create a second draft.

---

## One-time setup

### 1. Create the Ghost Admin API key

In Ghost Admin: **Settings → Advanced → Integrations → Add custom integration**.
Name it something like `discourse-sync`. Ghost will show you an **Admin API
Key** in the form `<id>:<secret>` — copy the whole thing, you'll need it as
a Worker secret below. Note the **API URL** shown too; it should match your
`GHOST_BASE_URL`.

### 2. Create a Discourse API key (read-only is enough)

In Discourse Admin: **API → New API Key**. Scope it to read-only if you can,
and ideally restrict it to a system user rather than your personal admin
account.

### 3. Install dependencies and create the KV namespace

```bash
cd discourse-to-ghost
npm install
npx wrangler kv:namespace create SYNCED_TOPICS
```

This prints an `id`. Paste it into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Set Worker secrets

```bash
npx wrangler secret put DISCOURSE_WEBHOOK_SECRET
npx wrangler secret put DISCOURSE_API_KEY
npx wrangler secret put GHOST_ADMIN_API_KEY
```

`DISCOURSE_WEBHOOK_SECRET` is one you make up yourself — you'll enter the
same value into Discourse's webhook config in the next step.

`DISCOURSE_API_USERNAME` is optional — it defaults to `system`, which is
correct for global API keys. Only set it if your key is scoped to a
specific user.

### 5. Edit `wrangler.toml` vars

Update `DISCOURSE_BASE_URL` and `GHOST_BASE_URL` if they differ from the
defaults already in the file. `PUBLISH_TAG` defaults to `publish` — change
it if you'd rather use a different tag name.

### 6. Deploy

```bash
npx wrangler deploy
```

This prints your Worker URL, e.g. `https://discourse-to-ghost.<you>.workers.dev`.
The webhook endpoint is that URL plus `/discourse-hook`.

### 7. Configure the Discourse webhook

In Discourse Admin: **API → Webhooks → New Webhook**.

- **Payload URL**: `https://discourse-to-ghost.<you>.workers.dev/discourse-hook`
- **Secret**: same value you put in `DISCOURSE_WEBHOOK_SECRET`
- **Content type**: `application/json`
- **Events**: at minimum enable "Post Event" and "Topic Event" (the Worker
  checks the payload for a topic and its tags, and ignores anything else)
- Optionally restrict to specific categories if you only want this active
  in particular sections of the forum

Save it, then use Discourse's "Send Test Payload" button — your Worker
should respond `200 Ignored: no topic in payload` for the test ping, which
confirms the connection and signature verification both work.

---

## Using it

Tag any topic with `publish`. Within a few seconds it should appear in
**Ghost Admin → Posts** as a draft, with the original Discourse content
converted to HTML and an attribution line linking back to the forum
thread.

Edit the topic again later (e.g. fix a typo) and the webhook re-fires, but
the Worker sees the topic ID already in KV and skips it — it won't touch
the Ghost draft a second time. If you genuinely want to re-sync a topic
(say, you want to pull in edits before the draft is published), delete its
entry from KV:

```bash
npx wrangler kv:key delete --binding=SYNCED_TOPICS "topic:<id>"
```

---

## Known limitations / things to revisit

- **Markdown conversion is intentionally minimal** (`src/convert.js`) — it
  handles headings, bold/italic, links, inline code, and fenced code
  blocks, which covers what 0x00sec posts typically use. It does **not**
  handle Discourse-specific markup like polls, oneboxes, or quoted-reply
  blocks. If a tagged topic uses those, the draft will need manual cleanup
  before publishing — which is exactly what the draft step is for.
- **Single-post sync only.** This pulls the topic's first post, not the
  full thread. If you want a "thread digest" style sync instead, that's a
  different conversion function in `convert.js` — happy to add it if you
  end up wanting it.
- **No image re-hosting.** Images embedded in the Discourse post are
  linked, not copied into Ghost's media library. If Discourse ever prunes
  old uploads this could break embedded images in old drafts — worth
  keeping an eye on if that becomes an issue.
- **Tags are passed through as-is** plus a fixed `from-forum` tag, so you
  can filter for these posts in Ghost later. Adjust in `convert.js` if you
  want different tag handling.
