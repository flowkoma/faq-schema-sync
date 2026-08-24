// Thin, rate-limit-aware wrapper around the Webflow Data API v2.
// Uses native fetch (Node 18+) — no SDK dependency, so nothing can drift.
//
// One client per site: each Webflow API token has its own rate limit, so
// requests are serialized per client through a promise chain that enforces
// minimum spacing and honors Retry-After on 429 responses.

import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWebflowClient(apiToken) {
  let chain = Promise.resolve();
  let lastRequestAt = 0;

  /**
   * Perform a rate-limited request against the Webflow API.
   * Retries on 429 and 5xx with backoff (max 4 attempts).
   * Throws on other non-2xx responses with status + body attached.
   */
  function request(method, path, body = undefined) {
    const run = async () => {
      const wait = lastRequestAt + config.apiSpacingMs - Date.now();
      if (wait > 0) await sleep(wait);

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        lastRequestAt = Date.now();

        const res = await fetch(`${config.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt >= 4) {
            const text = await res.text().catch(() => '');
            const err = new Error(`Webflow API ${res.status} after ${attempt} attempts: ${method} ${path} ${text}`);
            err.status = res.status;
            throw err;
          }
          const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
          const backoff = retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt;
          console.warn(`[webflow] ${res.status} on ${method} ${path} — retrying in ${backoff}ms (attempt ${attempt})`);
          await sleep(backoff);
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Webflow API ${res.status}: ${method} ${path} ${text}`);
          err.status = res.status;
          throw err;
        }

        if (res.status === 204) return null;
        return res.json();
      }
    };

    // Serialize all requests through the chain so spacing is per-token.
    const result = chain.then(run, run);
    chain = result.catch(() => {}); // keep the chain alive after failures
    return result;
  }

  // -------------------------------------------------------------------------
  // Typed helpers
  // -------------------------------------------------------------------------

  /** Get a single collection item (staged version). */
  const getItem = (collectionId, itemId) =>
    request('GET', `/collections/${collectionId}/items/${itemId}`);

  /** List one page of collection items (staged). */
  const listItemsPage = (collectionId, offset = 0, limit = 100) =>
    request('GET', `/collections/${collectionId}/items?offset=${offset}&limit=${limit}`);

  /** List ALL items in a collection (paginates until done). */
  async function listAllItems(collectionId) {
    const items = [];
    let offset = 0;
    const limit = 100;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await listItemsPage(collectionId, offset, limit);
      const pageItems = page?.items || [];
      items.push(...pageItems);
      const total = page?.pagination?.total ?? pageItems.length;
      offset += pageItems.length;
      if (offset >= total || pageItems.length === 0) break;
    }
    return items;
  }

  /** Update the LIVE (published) version of an item — no site publish needed. */
  const updateLiveItem = (collectionId, itemId, fieldData) =>
    request('PATCH', `/collections/${collectionId}/items/${itemId}/live`, { fieldData });

  /** Update the STAGED version of an item. */
  const updateStagedItem = (collectionId, itemId, fieldData) =>
    request('PATCH', `/collections/${collectionId}/items/${itemId}`, { fieldData });

  /**
   * Write fieldData to the live item; if that fails because the item has never
   * been published (or is draft-only), fall back to the staged item so the
   * value is ready the moment the client publishes.
   */
  async function updateItemPreferLive(collectionId, itemId, fieldData) {
    try {
      await updateLiveItem(collectionId, itemId, fieldData);
      return 'live';
    } catch (err) {
      if (err.status === 404 || err.status === 409 || err.status === 400) {
        await updateStagedItem(collectionId, itemId, fieldData);
        return 'staged';
      }
      throw err;
    }
  }

  return {
    request,
    getItem,
    listItemsPage,
    listAllItems,
    updateLiveItem,
    updateStagedItem,
    updateItemPreferLive,
  };
}

// ---------------------------------------------------------------------------
// Per-site client cache (invalidated when the site's token changes)
// ---------------------------------------------------------------------------

const cache = new Map(); // site.id -> { token, client }

export function clientForSite(site) {
  const cached = cache.get(site.id);
  if (cached && cached.token === site.apiToken) return cached.client;
  const client = createWebflowClient(site.apiToken);
  cache.set(site.id, { token: site.apiToken, client });
  return client;
}
