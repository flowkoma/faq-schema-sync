// Builds the FAQPage JSON-LD from FAQ items.
//
// Output is RAW JSON only — no <script> tags. The script wrapper lives in the
// HTML Embed on the Webflow blog template page:
//
//   <script type="application/ld+json">{{ FAQ Schema JSON field }}</script>
//
// Google permits a limited set of HTML tags inside acceptedAnswer.text:
// h1-h6, br, ol, ul, li, a, p, div, b, strong, i, em.
// Everything else is stripped. Questions are reduced to plain text.

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'br', 'ol', 'ul', 'li', 'a', 'p', 'div', 'b', 'strong', 'i', 'em',
]);

/** Remove entire elements whose content must never leak into schema. */
function dropDangerousBlocks(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Keep only allowed tags; strip all attributes except href on <a>.
 * Regex-based sanitization is acceptable here because the input is
 * CMS-authored content from Webflow's own rich text editor, not arbitrary
 * user input from the open web.
 */
function sanitizeAnswerHtml(html) {
  if (!html) return '';
  let out = dropDangerousBlocks(String(html));

  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const isClosing = match.startsWith('</');
    if (isClosing) return `</${tag}>`;
    if (tag === 'a') {
      const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
      const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
      // Only allow http(s) and relative links
      if (href && /^(https?:\/\/|\/)/i.test(href)) {
        return `<a href="${href}">`;
      }
      return '<a>';
    }
    if (tag === 'br') return '<br>';
    return `<${tag}>`;
  });

  return normalizeWhitespace(out);
}

/** Reduce to plain text: strip all tags, decode a few common entities. */
function toPlainText(html) {
  if (!html) return '';
  const stripped = dropDangerousBlocks(String(html)).replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(decodeBasicEntities(stripped));
}

function decodeBasicEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function normalizeWhitespace(text) {
  return text
    // strip control characters that would produce invalid JSON when embedded
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the FAQPage JSON string from an ordered array of
 * { question, answerHtml } objects. Returns '' when there are no usable FAQs
 * (meaning: the schema field should be cleared).
 *
 * Output is deterministic and compact, so byte-comparison against the stored
 * field value is a reliable "did anything change?" guard.
 */
export function buildFaqSchemaJson(faqs) {
  const mainEntity = (faqs || [])
    .map((f) => ({
      question: toPlainText(f.question),
      answer: sanitizeAnswerHtml(f.answerHtml),
    }))
    .filter((f) => f.question && f.answer)
    .map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.answer,
      },
    }));

  if (mainEntity.length === 0) return '';

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity,
  });
}
