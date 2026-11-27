'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build, faqEntries, PAGES } = require('../scripts/seo.js');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const cfg = JSON.parse(read('seo.config.json'));
const site = cfg.siteUrl;

const jsonLd = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('generated SEO files are up to date (run npm run seo after editing)', () => {
  for (const [name, content] of Object.entries(build(cfg))) assert.strictEqual(read(name), content, `${name} is stale`);
});

test('each page has one title, description and canonical pointing at the site address', () => {
  for (const page of PAGES) {
    const html = read(page.file);
    assert.strictEqual(html.match(/<title>/g).length, 1, page.file);
    assert.strictEqual(html.match(/<meta name="description"/g).length, 1, page.file);
    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    assert.strictEqual(canonicals.length, 1, page.file);
    assert.strictEqual(canonicals[0][1], `${site}${page.path}`);
    assert.ok(page.title.length <= 65, `${page.file} title is ${page.title.length} chars`);
    assert.ok(page.description.length >= 120 && page.description.length <= 160, `${page.file} description length`);
    assert.strictEqual(html.match(/<h1[\s>]/g).length, 1, `${page.file} has one h1`);
    for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card']) assert.match(html, new RegExp(`"${prop}"`));
    assert.doesNotMatch(html, /R0\.30/, 'no price in page metadata');
  }
});

test('structured data parses; the FAQPage matches the visible questions', () => {
  const home = jsonLd(read('index.html'));
  assert.strictEqual(home.length, 1);
  const types = home[0]['@graph'].map((n) => [].concat(n['@type']).join(','));
  assert.ok(types.includes('Organization,Manufacturer') && types.includes('WebSite'));

  const faqHtml = read('faq.html');
  const visible = (faqHtml.match(/<details>/g) || []).length;
  const faq = jsonLd(faqHtml)[0]['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.strictEqual(faq.mainEntity.length, visible);
  assert.strictEqual(visible, faqEntries(faqHtml).length);
  for (const q of faq.mainEntity) {
    assert.ok(q.name.endsWith('?'), q.name);
    assert.ok(q.acceptedAnswer.text.length > 20 && !/[<>]/.test(q.acceptedAnswer.text), q.name);
  }
});

test('robots.txt and sitemap.xml point at the site address and list both pages', () => {
  assert.match(read('robots.txt'), new RegExp(`^Sitemap: ${site}/sitemap.xml$`, 'm'));
  const sitemap = read('sitemap.xml');
  for (const page of PAGES) assert.ok(sitemap.includes(`<loc>${site}${page.path}</loc>`), page.path);
  assert.doesNotMatch(sitemap + read('robots.txt'), /tenfoldtender/);
});

test('icons and the share image exist at the declared sizes', () => {
  for (const f of ['assets/favicon.svg', 'assets/favicon-48.png', 'assets/apple-touch-icon.png', 'assets/images/og-preview.jpg']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
  const png = fs.readFileSync(path.join(ROOT, 'assets/apple-touch-icon.png'));
  assert.strictEqual(png.readUInt32BE(16), 180);
});
