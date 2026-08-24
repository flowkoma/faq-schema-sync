# faq-schema-sync

A small Node.js service that keeps FAQPage JSON-LD schema in sync on Webflow blog posts — for **any number of Webflow sites**, managed through a built-in admin UI. No tokens or IDs in code or environment variables.

**The problem it solves:** Webflow cannot loop through multi-referenced items inside template page head/embed code, so FAQ schema can't be built natively from a multi-reference field. This service listens for CMS webhooks, reads the referenced FAQ items via the Data API v2, generates the FAQPage JSON, and writes it into a plain text field on the blog item — updating the **live** item directly, so no site republish is needed. The raw JSON is baked into the published HTML (readable by all crawlers and AI bots, no JavaScript execution required).

## How it works

```
Editor publishes/edits blog post ──► Webflow webhook ──► this service
                                                            │
                     ┌──────────────────────────────────────┘
                     ▼
          fetch blog item ► resolve FAQ multi-ref (in order)
                     ▼
          build FAQPage JSON (sanitized, deterministic)
                     ▼
          identical to stored value? ── yes ──► stop (loop guard)
                     │ no
                     ▼
          PATCH live item (staged fallback if never published)
```

An FAQ item edited **independently** fires no webhook on the blog posts referencing it, so FAQ-collection events trigger a reverse lookup: scan the blog collection, find every post referencing that FAQ id, and regenerate each one. Deletions are handled the same way — Webflow removes deleted items from multi-reference arrays, so regeneration naturally drops them from the schema.

## Multi-site management

Everything site-specific — API token, site ID, collection IDs, field slugs — is entered through the **admin UI** at `/` (protected by `ADMIN_PASSWORD`) and persisted to `DATA_DIR/sites.json`. Each site gets its own webhook endpoint:

```
POST /webhooks/webflow/<site-config-id>?token=<per-site-secret>
```

The UI can, per site:

- **Test connection** — verifies the token, both collections, and that every configured field slug actually exists (with type checks). When a slug doesn't match, it lists every field in the collection with its slug, display name, and type — the most common mistake is entering display names (e.g. "FAQ jsonld") instead of slugs (`faq-jsonld`).
- **Register webhooks** — creates the three CMS webhooks in Webflow via the API, pointing at this deployment. Re-clicking replaces previous registrations instead of duplicating them.
- **Resync all posts** — backfill/recovery: regenerates the schema for every blog post.

## One-time Webflow setup (per site)

1. **Blog collection:** add a **plain text** field, e.g. "FAQ Schema JSON" (slug `faq-schema-json`). Add help text: *"Auto-generated — do not edit."* Do **not** use a rich text field (Webflow sanitizes rich text and would break the JSON).
2. **Blog template page:** add an **HTML Embed** anywhere in the body:

   ```html
   <script type="application/ld+json">{{ FAQ Schema JSON }}</script>
   ```

   Insert the field with the embed's **+ Add Field** button — don't type the placeholder manually. Set the embed's **conditional visibility** to *"FAQ Schema JSON is set"* so posts without FAQs render no empty script tag.
3. Note the **site ID**, **collection IDs** (Designer: collection settings, or via API), and **field slugs**.
4. Create a **site token** with **CMS: read and write** and **Sites: read and write** scopes (`sites:write` is required for webhook registration — with read-only Sites, everything works except the **Register webhooks** button). All other scope categories can stay at *No access*.

## Deploy to Railway

1. Push this repo to GitHub and create a new Railway project from it. Railway auto-detects Node and runs `npm start`.
2. Set `ADMIN_PASSWORD` in Railway's Variables tab (generate with `openssl rand -hex 16`).
3. **Attach a volume** (right-click the service → *Attach volume*) mounted at `/data`, and set `DATA_DIR=/data` — otherwise site configs are lost on every redeploy.
4. **Generate a public domain** (service → Settings → Networking → *Generate Domain*). The target port must match the port the app listens on: Railway injects a `PORT` variable (typically `8080`) which the app uses, so pick the same port for the domain. If you get a 502 with the app logging `listening on :8080`, the domain is pointing at the wrong port.
5. Confirm `GET https://your-app.up.railway.app/health` returns `{"ok":true,...}`.

Every push to `main` auto-deploys. Site configs live on the volume, so deploys never touch them.

## Onboard a site

1. Open `https://your-app.up.railway.app/`, sign in with the admin password.
2. **+ Add site**, fill in the token, site ID, collection IDs, and field **slugs** (not display names — collection settings show the slug on each field).
3. Click **Test connection** — fix anything red.
4. Click **Register webhooks**.
5. Click **Resync all posts** to backfill existing content. Watch the Railway logs — each post logs `updated / skipped (unchanged) / cleared`.

**Note:** Webflow CMS webhooks are site-wide (they fire for every collection); the service filters by `collectionId` internally and ignores unrelated collections.

## Validate

Open a live blog post, view source, confirm the `application/ld+json` block is present with real content, then run the URL through Google's Rich Results Test / Schema.org validator.

## Behavior notes

- **Debounce:** rapid consecutive saves collapse into one regeneration per item (default 12s window).
- **Rate limits:** API calls are spaced per site token (default 1.1s apart, ~55/min) with automatic backoff on 429.
- **Loop safety:** the service's own write fires a webhook, but regeneration produces byte-identical JSON and is skipped — no infinite loop.
- **Draft/archived FAQs** are excluded from the schema. FAQ order follows the multi-reference field order.
- **Never-published blog posts:** the live PATCH fails, so the value is written to the staged item instead — ready the moment the client publishes.
- **Removing all FAQs from a post** clears the schema field (and the embed hides via conditional visibility).
- **Security:** webhook endpoints are per-site with a random URL secret; the admin UI/API require `ADMIN_PASSWORD` (sent as `x-admin-token`). API tokens are stored in `sites.json` on the volume — masked in the UI, never sent back to the browser.

## Local run / test

```bash
npm install
npm test                                  # offline smoke tests, no API calls
ADMIN_PASSWORD=dev npm start              # UI at http://localhost:3000
```
