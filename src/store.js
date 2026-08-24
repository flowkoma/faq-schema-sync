// Persistent store for site configurations.
//
// A "site" is one Webflow site this service manages: its API token,
// collection IDs, and field slugs. Sites are created/edited through the
// admin UI and persisted as JSON in DATA_DIR/sites.json (atomic writes).
//
// Each site gets a random urlToken at creation time; the webhook URL
// registered with Webflow is /webhooks/webflow/<site.id>?token=<urlToken>,
// so inbound webhooks are both routed and authenticated per site.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'sites.json');

let sites = [];

export function loadStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      sites = Array.isArray(parsed.sites) ? parsed.sites : [];
    } catch (err) {
      // Never silently wipe the store on a parse error — refuse to start.
      console.error(`Could not parse ${FILE}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`[store] loaded ${sites.length} site(s) from ${FILE}`);
}

function persist() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sites }, null, 2));
  fs.renameSync(tmp, FILE);
}

export function listSites() {
  return sites;
}

export function getSite(id) {
  return sites.find((s) => s.id === id) || null;
}

const DEFAULTS = {
  blogFaqRefSlug: 'faqs',
  blogSchemaFieldSlug: 'faq-schema-json',
  faqQuestionSlug: 'name',
  faqAnswerSlug: 'answer',
};

const REQUIRED = ['name', 'siteId', 'blogCollectionId', 'faqCollectionId'];

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Create or update a site config. `input.id` present = update (empty
 * apiToken means "keep the existing token"). Throws Error with .statusCode
 * on validation problems.
 */
export function upsertSite(input) {
  const existing = input.id ? getSite(clean(input.id)) : null;
  if (input.id && !existing) {
    const err = new Error('Site not found');
    err.statusCode = 404;
    throw err;
  }

  const site = existing
    ? { ...existing }
    : {
        id: crypto.randomBytes(8).toString('hex'),
        urlToken: crypto.randomBytes(24).toString('hex'),
        createdAt: new Date().toISOString(),
      };

  for (const key of REQUIRED) {
    const value = clean(input[key] ?? site[key]);
    if (!value) {
      const err = new Error(`Missing required field: ${key}`);
      err.statusCode = 400;
      throw err;
    }
    site[key] = value;
  }

  const token = clean(input.apiToken);
  if (token) site.apiToken = token;
  if (!site.apiToken) {
    const err = new Error('Missing required field: apiToken');
    err.statusCode = 400;
    throw err;
  }

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    site[key] = clean(input[key]) || site[key] || fallback;
  }

  // Optional HMAC secret (Webflow signs webhooks created by OAuth apps;
  // site-token webhooks rely on the urlToken instead).
  if (input.webhookSecret !== undefined) site.webhookSecret = clean(input.webhookSecret);

  site.updatedAt = new Date().toISOString();

  if (existing) {
    sites = sites.map((s) => (s.id === site.id ? site : s));
  } else {
    sites.push(site);
  }
  persist();
  return site;
}

export function markWebhooksRegistered(id, url) {
  const site = getSite(id);
  if (!site) return;
  site.webhooksRegisteredAt = new Date().toISOString();
  site.webhookUrl = url;
  persist();
}

export function deleteSite(id) {
  const before = sites.length;
  sites = sites.filter((s) => s.id !== id);
  if (sites.length !== before) persist();
  return sites.length !== before;
}

/** Redacted copy safe to send to the admin UI (token masked). */
export function maskSite(site) {
  const { apiToken, ...rest } = site;
  return {
    ...rest,
    apiTokenMasked: apiToken ? `••••••••${apiToken.slice(-4)}` : '',
  };
}
