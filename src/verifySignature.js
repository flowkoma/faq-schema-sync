// Webflow webhook request validation — per site.
//
// Two layers, both checked when configured on the site:
//   1. URL token (always generated per site) — the webhook URL registered in
//      Webflow includes ?token=..., and we check it here. Simple but
//      effective since the URL is only known to you and Webflow.
//   2. HMAC (optional site.webhookSecret) — Webflow signs webhook requests
//      with HMAC-SHA256:
//        signature = HMAC_SHA256(secret, `${timestamp}:${rawBody}`)
//      sent in `x-webflow-signature`, Unix ms timestamp in
//      `x-webflow-timestamp`. Only available for OAuth-app-created webhooks.

import crypto from 'node:crypto';
import { config } from './config.js';

export function verifyWebhookRequest(request, site) {
  // Layer 1: URL token
  if (site.urlToken) {
    const token = request.query?.token || '';
    const a = Buffer.from(site.urlToken, 'utf8');
    const b = Buffer.from(String(token), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad url token' };
    }
  }

  // Layer 2: HMAC, if configured for this site
  if (site.webhookSecret) {
    const signature = request.headers['x-webflow-signature'];
    const timestamp = request.headers['x-webflow-timestamp'];
    const rawBody = request.rawBody || '';

    if (!signature || !timestamp) {
      return { ok: false, reason: 'missing signature headers' };
    }

    const age = Date.now() - parseInt(timestamp, 10);
    if (Number.isNaN(age) || age > config.maxWebhookAgeMs || age < -60000) {
      return { ok: false, reason: 'stale or invalid timestamp' };
    }

    const expected = crypto
      .createHmac('sha256', site.webhookSecret)
      .update(`${timestamp}:${rawBody}`)
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'signature mismatch' };
    }
  }

  return { ok: true };
}
