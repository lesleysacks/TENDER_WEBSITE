#!/usr/bin/env node
/*
 * SEO generator. Writes everything that depends on the site address in one go:
 *   - the <!-- seo:start --> … <!-- seo:end --> block in each page's <head>
 *     (title, description, canonical, Open Graph, Twitter, JSON-LD)
 *   - robots.txt and sitemap.xml
 *
 * The FAQ structured data is built from the questions visible on faq.html, so the two never drift.
 * Business details (phone, area, social links…) come from seo.config.json and are only published
 * when filled in.
 *
 *   npm run seo                                  regenerate (sets lastModified to today)
 *   npm run seo -- --url=https://www.example.co.za   switch the site address, then regenerate
 *   node scripts/seo.js --check                  exit 1 if any generated file is out of date
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'seo.config.json');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const urlArg = (args.find((a) => a.startsWith('--url=')) || '').slice('--url='.length);

const BRAND = 'PureLine Hygiene';

const PAGES = [
  {
    file: 'index.html',
    path: '/',
    title: 'Bulk Sanitary Pads for Tenders | South Africa | PureLine Hygiene',
    description:
      'South African manufacturer & supplier of feminine hygiene products. Sanitary pads in packs of 10 for tenders, schools and organisations. Request a quote.',
    ogTitle: 'Bulk Sanitary Pad Supplier, South Africa | PureLine Hygiene',
    jsonLd: (site, cfg) => ({ '@context': 'https://schema.org', '@graph': [organization(site, cfg), website(site)] }),
  },
  {
    file: 'faq.html',
    path: '/faq.html',
    title: 'Sanitary Pad Supply FAQs | Tenders & Quotes | PureLine Hygiene',
    description:
      'Answers on bulk sanitary pad supply in South Africa: tender orders, price per pack, quote requests, SANS 1043 compliance, orders and privacy.',
    ogTitle: 'Sanitary Pad Supply FAQs | PureLine Hygiene',
    jsonLd: (site, cfg, html) => ({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'FAQPage',
          '@id': `${site}/faq.html#faq`,
          url: `${site}/faq.html`,
          inLanguage: 'en-ZA',
          isPartOf: { '@id': `${site}/#website` },
          mainEntity: faqEntries(html).map(({ q, a }) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${site}/` },
            { '@type': 'ListItem', position: 2, name: 'FAQs', item: `${site}/faq.html` },
          ],
        },
      ],
    }),
  },
];

function organization(site, cfg) {
  const b = cfg.business || {};
  const org = {
    '@type': ['Organization', 'Manufacturer'],
    '@id': `${site}/#organization`,
    name: BRAND,
    url: `${site}/`,
    logo: { '@type': 'ImageObject', url: `${site}/assets/apple-touch-icon.png`, width: 180, height: 180 },
    image: `${site}/assets/images/og-preview.jpg`,
    description:
      'Specialist manufacturers and suppliers of feminine hygiene products in South Africa. Sanitary pads packed in sealed bags of 10, supplied in volume for government tenders, schools and organisations. B-BBEE Level 2 certified and 100% women owned.',
    slogan: 'We are geared to supply quantities that meet your needs.',
    knowsAbout: [
      'sanitary pads',
      'feminine hygiene products',
      'bulk sanitary pad supply',
      'government tender supply',
      'sanitary pad manufacturing',
      'SANS 1043',
    ],
    hasCertification: [
      { '@type': 'Certification', name: 'SANS 1043 compliant – tested by SABS laboratory' },
      { '@type': 'Certification', name: 'B-BBEE Level 2' },
    ],
    areaServed: { '@type': 'Country', name: b.areaServed || 'South Africa' },
    address: { '@type': 'PostalAddress', addressCountry: 'ZA' },
  };
  if (b.locality) org.address.addressLocality = b.locality;
  if (b.region) org.address.addressRegion = b.region;
  if (b.email) org.email = b.email;
  if (b.telephone) org.telephone = b.telephone;
  if (Array.isArray(b.sameAs) && b.sameAs.length) org.sameAs = b.sameAs;
  if (b.email || b.telephone) {
    org.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'sales',
      areaServed: 'ZA',
      availableLanguage: ['en'],
      ...(b.email ? { email: b.email } : {}),
      ...(b.telephone ? { telephone: b.telephone } : {}),
    };
  }
  return org;
}

function website(site) {
  return {
    '@type': 'WebSite',
    '@id': `${site}/#website`,
    url: `${site}/`,
    name: BRAND,
    inLanguage: 'en-ZA',
    publisher: { '@id': `${site}/#organization` },
  };
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Every <details><summary>Q</summary>…answer…</details> on the FAQ page. */
function faqEntries(html) {
  const out = [];
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
  let m;
  while ((m = re.exec(html))) out.push({ q: decode(m[1]), a: decode(m[2]) });
  return out;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function headBlock(page, site, cfg, html) {
  const url = `${site}${page.path}`;
  const image = `${site}/assets/images/og-preview.jpg`;
  const json = JSON.stringify(page.jsonLd(site, cfg, html), null, 2)
    .replace(/</g, '\\u003c')
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return [
    '<!-- seo:start (generated by scripts/seo.js — edit there, then run npm run seo) -->',
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta name="robots" content="index, follow, max-image-preview:large" />',
    `<meta property="og:site_name" content="${BRAND}" />`,
    '<meta property="og:locale" content="en_ZA" />',
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(page.ogTitle)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:image" content="${image}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="PureLine Hygiene: bulk sanitary pad supplier, South Africa" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(page.ogTitle)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    '<link rel="icon" href="assets/favicon.svg" type="image/svg+xml" />',
    '<link rel="icon" href="assets/favicon-48.png" type="image/png" sizes="48x48" />',
    '<link rel="apple-touch-icon" href="assets/apple-touch-icon.png" />',
    '<script type="application/ld+json">',
  ]
    .map((line) => `    ${line}`)
    .concat([json, '    </script>', '    <!-- seo:end -->'])
    .join('\n');
}

const MARKER = /<!-- seo:start[\s\S]*?<!-- seo:end -->/;

function robots(site) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n`;
}

function sitemap(site, lastmod) {
  const urls = PAGES.map(
    (p) =>
      `  <url>\n    <loc>${site}${p.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${p.path === '/' ? '1.0' : '0.7'}</priority>\n  </url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function build(cfg) {
  const site = cfg.siteUrl.replace(/\/+$/, '');
  const files = {};
  for (const page of PAGES) {
    const file = path.join(ROOT, page.file);
    const html = fs.readFileSync(file, 'utf8');
    if (!MARKER.test(html)) throw new Error(`${page.file}: missing <!-- seo:start --> … <!-- seo:end --> block`);
    files[page.file] = html.replace(MARKER, headBlock(page, site, cfg, html).trimStart());
  }
  files['robots.txt'] = robots(site);
  files['sitemap.xml'] = sitemap(site, cfg.lastModified);
  return files;
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (urlArg) {
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(urlArg.replace(/\/+$/, ''))) {
      console.error('Use a full https address without a path, e.g. --url=https://www.purelinehygiene.co.za');
      process.exit(2);
    }
    cfg.siteUrl = urlArg.replace(/\/+$/, '');
  }
  if (!CHECK) cfg.lastModified = new Date().toISOString().slice(0, 10);

  const files = build(cfg);
  const stale = Object.entries(files).filter(([name, content]) => {
    const p = path.join(ROOT, name);
    return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== content;
  });

  if (CHECK) {
    if (stale.length) {
      console.error(`SEO files out of date: ${stale.map(([n]) => n).join(', ')}. Run: npm run seo`);
      process.exit(1);
    }
    console.log('SEO files are up to date.');
    return;
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  for (const [name, content] of stale) fs.writeFileSync(path.join(ROOT, name), content);
  console.log(`Site address: ${cfg.siteUrl}`);
  console.log(stale.length ? `Updated: ${stale.map(([n]) => n).join(', ')}` : 'Nothing to update.');
}

if (require.main === module) main();
module.exports = { build, faqEntries, PAGES };
