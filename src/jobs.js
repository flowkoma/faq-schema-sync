// The three jobs of the app — all site-scoped:
//
// 1. regenerateForBlogItem(site, blogItemId)
//    Fetch blog item -> resolve FAQ multi-reference -> build JSON ->
//    compare -> write back (live, with staged fallback).
//
// 2. reverseLookupForFaqItem(site, faqItemId)
//    An FAQ item changed or was deleted. No webhook fires on the blog posts
//    that reference it, so scan the blog collection and regenerate every
//    post whose multi-reference array contains this FAQ id.
//
// 3. resyncAll(site)
//    Regenerate every blog post of a site. Used for backfill and recovery.

import { clientForSite } from './webflowClient.js';
import { buildFaqSchemaJson } from './schemaBuilder.js';
import { enqueueDebounced, enqueueImmediate } from './queue.js';

// ---------------------------------------------------------------------------
// Job 1: regenerate one blog post's FAQ schema
// ---------------------------------------------------------------------------

export async function regenerateForBlogItem(site, blogItemId) {
  const wf = clientForSite(site);

  const blogItem = await wf.getItem(site.blogCollectionId, blogItemId).catch((err) => {
    if (err.status === 404) return null; // item deleted meanwhile — nothing to do
    throw err;
  });
  if (!blogItem) return 'skipped (blog item gone)';

  const fieldData = blogItem.fieldData || {};
  const faqIds = Array.isArray(fieldData[site.blogFaqRefSlug])
    ? fieldData[site.blogFaqRefSlug]
    : [];
  const currentJson = (fieldData[site.blogSchemaFieldSlug] || '').trim();

  // Resolve FAQ items IN THE ORDER the client arranged them in the multi-ref.
  const faqs = [];
  for (const faqId of faqIds) {
    const faqItem = await wf.getItem(site.faqCollectionId, faqId).catch((err) => {
      if (err.status === 404) return null; // dangling reference — skip
      throw err;
    });
    if (!faqItem) continue;
    if (faqItem.isDraft || faqItem.isArchived) continue; // unpublished FAQs stay out
    faqs.push({
      question: faqItem.fieldData?.[site.faqQuestionSlug] || '',
      answerHtml: faqItem.fieldData?.[site.faqAnswerSlug] || '',
    });
  }

  const newJson = buildFaqSchemaJson(faqs);

  // Loop guard: identical output means our own earlier write (or no change).
  if (newJson === currentJson) return 'skipped (unchanged)';

  const target = await wf.updateItemPreferLive(site.blogCollectionId, blogItemId, {
    [site.blogSchemaFieldSlug]: newJson,
  });

  return newJson === ''
    ? `cleared schema (${target})`
    : `updated schema with ${faqs.length} FAQ(s) (${target})`;
}

// ---------------------------------------------------------------------------
// Job 2: FAQ edited/deleted independently -> find and refresh affected posts
// ---------------------------------------------------------------------------

export async function reverseLookupForFaqItem(site, faqItemId) {
  const wf = clientForSite(site);
  const blogItems = await wf.listAllItems(site.blogCollectionId);

  const affected = blogItems.filter((item) => {
    const refs = item.fieldData?.[site.blogFaqRefSlug];
    return Array.isArray(refs) && refs.includes(faqItemId);
  });

  for (const item of affected) {
    // Route through the same debounced queue so several FAQ edits in a row
    // collapse into one regeneration per post.
    enqueueDebounced(`${site.id}:blog:${item.id}`, () => regenerateForBlogItem(site, item.id));
  }

  return `queued ${affected.length} affected blog post(s) of ${blogItems.length}`;
}

// ---------------------------------------------------------------------------
// Job 3: full resync (backfill / recovery)
// ---------------------------------------------------------------------------

export async function resyncAll(site) {
  const wf = clientForSite(site);
  const blogItems = await wf.listAllItems(site.blogCollectionId);
  for (const item of blogItems) {
    enqueueImmediate(`${site.id}:blog:${item.id}`, () => regenerateForBlogItem(site, item.id));
  }
  return `queued ${blogItems.length} blog post(s) for regeneration`;
}
