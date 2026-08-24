// HTTP server.
//
// Routes:
//   GET  /                                 — admin UI (single-page, password gated client-side)
//   *    /api/sites...                     — admin API (x-admin-token header === ADMIN_PASSWORD)
//   POST /webhooks/webflow/:siteKey        — per-site Webflow webhook endpoint
//   GET  /health                           — liveness + queue stats
//
// NOTE ON ROUTING: Webflow's collection_item_* webhooks are registered at the
// SITE level — one webhook per trigger type fires for changes in EVERY
// collection on that site. Each managed site gets its own endpoint
// (/webhooks/webflow/<site.id>?token=...) which dispatches internally on
// payload.collectionId and ignores unrelated collections.

import Fastify from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  loadStore,
  listSites,
  getSite,
  upsertSite,
  deleteSite,
  maskSite,
  markWebhooksRegistered,
} from './store.js';
import { verifyWebhookRequest } from './verifySignature.js';
import { enqueueDebounced, enqueueImmediate, queueStats } from './queue.js';
import {
  regenerateForBlogItem,
  reverseLookupForFaqItem,
  resyncAll,
} from './jobs.js';
import {
  registerSiteWebhooks,
  listSiteWebhooks,
  testSiteConnection,
  webhookUrlForSite,
} from './siteOps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

loadStore();

const app = Fastify({ logger: false });

// Capture the raw body (needed for HMAC verification) while still parsing JSON.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body;
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});

/** Public base URL for building webhook URLs (PUBLIC_URL wins if set). */
function requestBaseUrl(request) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(request.headers['x-forwarded-proto'] || request.protocol || 'https').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Admin UI
// ---------------------------------------------------------------------------

app.get('/', async (request, reply) => {
  reply.type('text/html; charset=utf-8').send(UI_HTML);
});

// ---------------------------------------------------------------------------
// Admin API — every /api/* request must carry x-admin-token
// ---------------------------------------------------------------------------

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const provided = String(request.headers['x-admin-token'] || '');
  const a = Buffer.from(config.adminPassword, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return reply.code(401).send({ ok: false, error: 'unauthorized' });
  }
});

app.get('/api/sites', async (request) => {
  const base = requestBaseUrl(request);
  return {
    ok: true,
    sites: listSites().map((s) => ({ ...maskSite(s), webhookUrl: webhookUrlForSite(s, base) })),
    queue: queueStats(),
  };
});

app.post('/api/sites', async (request, reply) => {
  try {
    const site = upsertSite(request.body || {});
    return { ok: true, site: maskSite(site) };
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ ok: false, error: err.message });
  }
});

app.delete('/api/sites/:id', async (request, reply) => {
  const removed = deleteSite(request.params.id);
  if (!removed) return reply.code(404).send({ ok: false, error: 'not found' });
  return { ok: true };
});

app.post('/api/sites/:id/register-webhooks', async (request, reply) => {
  const site = getSite(request.params.id);
  if (!site) return reply.code(404).send({ ok: false, error: 'not found' });
  try {
    const result = await registerSiteWebhooks(site, requestBaseUrl(request));
    markWebhooksRegistered(site.id, result.url);
    return { ok: true, ...result };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err.message });
  }
});

app.get('/api/sites/:id/webhooks', async (request, reply) => {
  const site = getSite(request.params.id);
  if (!site) return reply.code(404).send({ ok: false, error: 'not found' });
  try {
    return { ok: true, webhooks: await listSiteWebhooks(site) };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err.message });
  }
});

app.post('/api/sites/:id/test', async (request, reply) => {
  const site = getSite(request.params.id);
  if (!site) return reply.code(404).send({ ok: false, error: 'not found' });
  try {
    return await testSiteConnection(site);
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err.message });
  }
});

app.post('/api/sites/:id/resync', async (request, reply) => {
  const site = getSite(request.params.id);
  if (!site) return reply.code(404).send({ ok: false, error: 'not found' });
  enqueueImmediate(`${site.id}:resync-all`, () => resyncAll(site));
  return reply.code(202).send({ ok: true, message: 'Resync queued. Watch the logs for progress.' });
});

// ---------------------------------------------------------------------------
// Webhook endpoint — acknowledge fast, process in the background
// ---------------------------------------------------------------------------

app.post('/webhooks/webflow/:siteKey', async (request, reply) => {
  const site = getSite(request.params.siteKey);
  if (!site) {
    console.warn(`[webhook] rejected: unknown site key ${request.params.siteKey}`);
    return reply.code(404).send({ ok: false });
  }

  const check = verifyWebhookRequest(request, site);
  if (!check.ok) {
    console.warn(`[webhook] rejected for site "${site.name}": ${check.reason}`);
    return reply.code(401).send({ ok: false });
  }

  const { triggerType, payload } = request.body || {};
  const itemId = payload?.id;
  const collectionId = payload?.collectionId;

  // Always 200 quickly — Webflow retries non-2xx deliveries and we never want
  // processing time or downstream errors to cause duplicate deliveries.
  reply.code(200).send({ ok: true });

  if (!triggerType || !itemId || !collectionId) {
    console.warn('[webhook] ignored: malformed payload', { triggerType, itemId, collectionId });
    return;
  }

  // --- Blog collection: regenerate that post's schema ---
  if (collectionId === site.blogCollectionId) {
    if (triggerType === 'collection_item_created' || triggerType === 'collection_item_changed') {
      console.log(`[webhook] [${site.name}] ${triggerType} on blog item ${itemId}`);
      enqueueDebounced(`${site.id}:blog:${itemId}`, () => regenerateForBlogItem(site, itemId));
    }
    // collection_item_deleted on blog: nothing to do, the page is gone.
    return;
  }

  // --- FAQ collection: reverse lookup fallback for independent edits ---
  if (collectionId === site.faqCollectionId) {
    if (
      triggerType === 'collection_item_changed' ||
      triggerType === 'collection_item_created' ||
      triggerType === 'collection_item_deleted'
    ) {
      console.log(`[webhook] [${site.name}] ${triggerType} on FAQ item ${itemId}`);
      // Debounce per FAQ id: rapid consecutive edits to one FAQ collapse
      // into a single blog-collection scan.
      enqueueDebounced(`${site.id}:faq-lookup:${itemId}`, () => reverseLookupForFaqItem(site, itemId));
    }
    return;
  }

  // Any other collection on the site — not our business.
  console.log(`[webhook] [${site.name}] ignored ${triggerType} for unrelated collection ${collectionId}`);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', async () => ({
  ok: true,
  time: new Date().toISOString(),
  sites: listSites().length,
  queue: queueStats(),
}));

// ---------------------------------------------------------------------------

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`faq-schema-sync listening on :${config.port}`))
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
