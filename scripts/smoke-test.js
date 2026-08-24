// Offline smoke test — verifies the pure logic (schema building, sanitization,
// signature verification, queue debounce, site store) without touching the
// Webflow API. Run with: npm test

import os from 'node:os';
import path from 'node:path';

process.env.ADMIN_PASSWORD ||= 'test-password';
process.env.DATA_DIR ||= path.join(os.tmpdir(), `faq-schema-sync-test-${Date.now()}`);

const { buildFaqSchemaJson } = await import('../src/schemaBuilder.js');
const { verifyWebhookRequest } = await import('../src/verifySignature.js');
const crypto = await import('node:crypto');

let failures = 0;
function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✖ ${name} ${detail}`);
  }
}

// --- schema builder ---
console.log('schemaBuilder:');
const json = buildFaqSchemaJson([
  { question: '<strong>What is Webflow?</strong>', answerHtml: '<p>A <b>visual</b> dev platform.</p><script>alert(1)</script>' },
  { question: 'How much does it cost?', answerHtml: '<p>See <a href="https://webflow.com/pricing" target="_blank" onclick="x()">pricing</a>.</p>' },
  { question: '', answerHtml: '<p>orphan answer, should be dropped</p>' },
]);
const parsed = JSON.parse(json);
assert('produces valid JSON', typeof parsed === 'object');
assert('FAQPage type', parsed['@type'] === 'FAQPage');
assert('drops empty-question entries', parsed.mainEntity.length === 2);
assert('question reduced to plain text', parsed.mainEntity[0].name === 'What is Webflow?');
assert('script tag stripped from answer', !parsed.mainEntity[0].acceptedAnswer.text.includes('alert'));
assert('allowed tags preserved', parsed.mainEntity[0].acceptedAnswer.text.includes('<b>visual</b>'));
assert('href kept, other attrs stripped', parsed.mainEntity[1].acceptedAnswer.text.includes('<a href="https://webflow.com/pricing">')
  && !parsed.mainEntity[1].acceptedAnswer.text.includes('onclick'));
assert('deterministic output', json === buildFaqSchemaJson([
  { question: '<strong>What is Webflow?</strong>', answerHtml: '<p>A <b>visual</b> dev platform.</p><script>alert(1)</script>' },
  { question: 'How much does it cost?', answerHtml: '<p>See <a href="https://webflow.com/pricing" target="_blank" onclick="x()">pricing</a>.</p>' },
  { question: '', answerHtml: '<p>orphan answer, should be dropped</p>' },
]));
assert('empty input clears field', buildFaqSchemaJson([]) === '');

// --- signature verification (per site) ---
console.log('verifySignature:');
const site = { urlToken: 'url-token-123', webhookSecret: 'shhh' };
const body = JSON.stringify({ triggerType: 'collection_item_changed', payload: { id: 'x' } });
const ts = String(Date.now());
const sig = crypto.createHmac('sha256', 'shhh').update(`${ts}:${body}`).digest('hex');

assert('valid request accepted', verifyWebhookRequest({
  headers: { 'x-webflow-signature': sig, 'x-webflow-timestamp': ts },
  rawBody: body,
  query: { token: 'url-token-123' },
}, site).ok);

assert('bad url token rejected', !verifyWebhookRequest({
  headers: { 'x-webflow-signature': sig, 'x-webflow-timestamp': ts },
  rawBody: body,
  query: { token: 'wrong' },
}, site).ok);

assert('tampered body rejected', !verifyWebhookRequest({
  headers: { 'x-webflow-signature': sig, 'x-webflow-timestamp': ts },
  rawBody: body + ' ',
  query: { token: 'url-token-123' },
}, site).ok);

assert('stale timestamp rejected', !verifyWebhookRequest({
  headers: {
    'x-webflow-signature': crypto.createHmac('sha256', 'shhh').update(`1000:${body}`).digest('hex'),
    'x-webflow-timestamp': '1000',
  },
  rawBody: body,
  query: { token: 'url-token-123' },
}, site).ok);

assert('url-token-only site accepted without signature', verifyWebhookRequest({
  headers: {},
  rawBody: body,
  query: { token: 'url-token-123' },
}, { urlToken: 'url-token-123', webhookSecret: '' }).ok);

// --- site store ---
console.log('store:');
const { loadStore, upsertSite, listSites, getSite, deleteSite, maskSite } = await import('../src/store.js');
loadStore();
const created = upsertSite({
  name: 'Test Site',
  apiToken: 'secret-token-abcd',
  siteId: 'site1',
  blogCollectionId: 'blog1',
  faqCollectionId: 'faq1',
});
assert('site created with id + urlToken', !!created.id && created.urlToken.length >= 32);
assert('slug defaults applied', created.blogFaqRefSlug === 'faqs' && created.blogSchemaFieldSlug === 'faq-schema-json');
const updated = upsertSite({ id: created.id, name: 'Renamed', apiToken: '', siteId: 'site1', blogCollectionId: 'blog1', faqCollectionId: 'faq1' });
assert('update keeps token when blank', updated.apiToken === 'secret-token-abcd' && updated.name === 'Renamed');
assert('urlToken stable across updates', updated.urlToken === created.urlToken);
assert('masking hides token', !JSON.stringify(maskSite(updated)).includes('secret-token-abcd'));
let validationThrew = false;
try { upsertSite({ name: 'x' }); } catch { validationThrew = true; }
assert('missing fields rejected', validationThrew && listSites().length === 1);
assert('delete works', deleteSite(created.id) && getSite(created.id) === null);

// --- queue debounce ---
console.log('queue:');
const { enqueueDebounced } = await import('../src/queue.js');
let runs = 0;
enqueueDebounced('test:1', async () => { runs += 1; return 'ok'; }, 100);
enqueueDebounced('test:1', async () => { runs += 1; return 'ok'; }, 100); // resets timer
await new Promise((r) => setTimeout(r, 400));
assert('burst collapses to a single run', runs === 1, `(ran ${runs} times)`);

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
