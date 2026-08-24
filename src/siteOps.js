// Admin operations on a site, driven from the UI:
//   - registerSiteWebhooks: (re)register the three CMS webhooks in Webflow,
//     pointing at this service's per-site endpoint. Removes stale webhooks
//     that point at the same endpoint first, so re-registering never
//     duplicates deliveries.
//   - listSiteWebhooks: raw list, for inspection.
//   - testSiteConnection: verifies the token, both collections, and that the
//     configured field slugs actually exist — surfaces misconfiguration
//     before any webhook ever fires.

import { clientForSite } from './webflowClient.js';

const TRIGGERS = [
  'collection_item_created',
  'collection_item_changed',
  'collection_item_deleted',
];

export function webhookUrlForSite(site, baseUrl) {
  return `${baseUrl}/webhooks/webflow/${site.id}?token=${encodeURIComponent(site.urlToken)}`;
}

export async function registerSiteWebhooks(site, baseUrl) {
  const wf = clientForSite(site);
  const url = webhookUrlForSite(site, baseUrl);

  // Remove previous registrations that point at this site config's endpoint
  // (e.g. after a redeploy to a new domain, or a repeated click).
  const existing = await wf.request('GET', `/sites/${site.siteId}/webhooks`);
  let removed = 0;
  for (const wh of existing?.webhooks || []) {
    if (wh.url && wh.url.includes(`/webhooks/webflow/${site.id}`)) {
      await wf.request('DELETE', `/webhooks/${wh.id}`);
      removed += 1;
    }
  }

  const registered = [];
  for (const triggerType of TRIGGERS) {
    const data = await wf.request('POST', `/sites/${site.siteId}/webhooks`, { triggerType, url });
    registered.push({ triggerType, id: data?.id });
  }

  return { url, removed, registered };
}

export function listSiteWebhooks(site) {
  const wf = clientForSite(site);
  return wf.request('GET', `/sites/${site.siteId}/webhooks`);
}

export async function testSiteConnection(site) {
  const wf = clientForSite(site);
  const checks = [];
  let ok = true;
  const add = (name, passed, detail = '') => {
    checks.push({ name, ok: passed, detail });
    if (!passed) ok = false;
  };

  const fieldCheck = (collection, label, slug, expectation) => {
    const field = (collection.fields || []).find((f) => f.slug === slug);
    if (!field) {
      add(`${label} field "${slug}"`, false, 'slug not found in collection');
      return;
    }
    add(`${label} field "${slug}"`, true, `type: ${field.type}${expectation && field.type !== expectation ? ` (expected ${expectation})` : ''}`);
  };

  let blog = null;
  try {
    blog = await wf.request('GET', `/collections/${site.blogCollectionId}`);
    add('Blog collection', true, blog.displayName || site.blogCollectionId);
  } catch (err) {
    add('Blog collection', false, err.message);
  }

  let faq = null;
  try {
    faq = await wf.request('GET', `/collections/${site.faqCollectionId}`);
    add('FAQ collection', true, faq.displayName || site.faqCollectionId);
  } catch (err) {
    add('FAQ collection', false, err.message);
  }

  if (blog) {
    fieldCheck(blog, 'Blog multi-ref', site.blogFaqRefSlug, 'MultiReference');
    fieldCheck(blog, 'Blog schema', site.blogSchemaFieldSlug, 'PlainText');
  }
  if (faq) {
    fieldCheck(faq, 'FAQ question', site.faqQuestionSlug, '');
    fieldCheck(faq, 'FAQ answer', site.faqAnswerSlug, '');
  }

  return { ok, checks };
}
