// Global service configuration.
//
// Per-site Webflow settings (API tokens, collection IDs, field slugs) do NOT
// live here — they are entered through the admin UI and persisted by
// src/store.js. The only secret the environment must provide is
// ADMIN_PASSWORD, which protects the UI and the admin API.

const adminPassword = process.env.ADMIN_PASSWORD || '';
if (!adminPassword) {
  console.error('ADMIN_PASSWORD is required — it protects the admin UI and API. Set it and restart.');
  process.exit(1);
}

export const config = {
  adminPassword,

  // Where sites.json is stored. On Railway, attach a volume (e.g. mounted at
  // /data) and set DATA_DIR=/data so site configs survive redeploys.
  dataDir: process.env.DATA_DIR || './data',

  // Optional explicit public base URL (e.g. https://myapp.up.railway.app).
  // When unset, webhook URLs are derived from the incoming request's
  // x-forwarded-proto / x-forwarded-host headers (Railway sets these).
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  apiBase: process.env.WEBFLOW_API_BASE || 'https://api.webflow.com/v2',

  // --- Behavior tuning ---
  // Debounce window per blog item before regeneration runs (ms)
  debounceMs: parseInt(process.env.DEBOUNCE_MS || '12000', 10),
  // Minimum spacing between Webflow API calls per site token (ms). 1100ms
  // keeps us safely under the 60 req/min default limit even with retries.
  apiSpacingMs: parseInt(process.env.API_SPACING_MS || '1100', 10),
  // Max age of a webhook timestamp before we reject it (ms)
  maxWebhookAgeMs: parseInt(process.env.MAX_WEBHOOK_AGE_MS || '300000', 10),

  port: parseInt(process.env.PORT || '3000', 10),
};
