/*
 * Browser end-to-end test: drives headless Chrome through the DevTools protocol (no dependencies).
 * Runs the real server against a temporary lead file, walks the full customer journey and saves
 * desktop and mobile screenshots to tests/e2e/output/.
 *
 *   npm run test:e2e            (set CHROME_PATH if Chrome/Edge is not in a standard location)
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createApp } = require('../../server/app.js');
const { FileLeadStore } = require('../../server/lead-store.js');
const { createLeadService } = require('../../server/lead-service.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const OUTPUT = path.join(here, 'output');
fs.mkdirSync(OUTPUT, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '✔' : '✖'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
}

// ---------- Server ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-e2e-'));
const store = await new FileLeadStore(path.join(dataDir, 'leads.json')).init();
const leadService = createLeadService({ store, notifier: { leadEvent: async () => {} } });
const server = createApp({ rootDir: ROOT, leadService });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- Chrome ----------
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('Chrome or Edge not found. Set CHROME_PATH.');
  process.exit(2);
}
// The profile lives in the (git-ignored) output folder; some sandboxed temp folders block Chrome.
const profile = fs.mkdtempSync(path.join(OUTPUT, 'chrome-profile-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let port;
for (let i = 0; i < 300 && !port; i += 1) {
  try {
    port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  } catch {
    await sleep(100);
  }
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let nextId = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || 'exception');
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/fonts\.(googleapis|gstatic)/.test(msg.params.entry.url || '')) {
    pageErrors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};
const waitFor = async (expression, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(80);
  }
  return false;
};
async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor('document.readyState === "complete" && !!window.PureLineEstimator || document.readyState === "complete" && !document.querySelector("[data-qty-input]")', 10000);
  await sleep(150);
}
async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
}
async function screenshot(name) {
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16000), scale: 1 },
  });
  fs.writeFileSync(path.join(OUTPUT, `${name}.png`), Buffer.from(data, 'base64'));
}
async function shotElement(name, selector) {
  const clip = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: Math.min(r.height, 3000), scale: 1 }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  fs.writeFileSync(path.join(OUTPUT, `${name}.png`), Buffer.from(data, 'base64'));
}
const type = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  el.focus(); el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true; })()`);
const click = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)}).click(), true)`);
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, ' ').trim()`);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await viewport(1366, 900);
  await goto(`${BASE}/`);

  await sleep(800); // let web fonts settle for the screenshots
  await shotElement('section-hero', '.hero');
  await shotElement('section-estimator', '#calculator');
  await shotElement('section-credentials', '.credentials');

  // ---- Hero ----
  check('hero heading', (await text('h1')) === 'Congratulations on securing your tender!');
  check('nav has Calculator and FAQs only',
    (await evaluate('[...document.querySelectorAll(".main-nav a")].map(a => a.textContent.trim()).join("|")')) === 'Calculator|FAQs');
  check('FAQs nav links to the full FAQ page', (await evaluate('document.querySelector(".main-nav a:last-child").getAttribute("href")')) === 'faq.html');
  await click('.cta-row a.btn-primary');
  check('"Calculate Your Supply" goes to the estimator', await waitFor('location.hash === "#calculator"'));
  await click('.cta-row a.btn-outline');
  check('"Request a Booking" goes to the guided quantity step', await waitFor('location.hash === "#quantity-step"'));
  check('hero sub-heading says specialist manufacturers & suppliers', /Specialist manufacturers & suppliers\. Made in South Africa\./.test(await text('.hero-sub')));
  check('booking disclaimer removed from the hero', !(await evaluate('!!document.querySelector(".hero-note")')));
  check('"Which describes you?" options sit in the hero', (await evaluate('document.querySelectorAll(".hero input[name=leadType]").length')) === 4
    && (await evaluate('document.querySelectorAll("input[name=leadType]").length')) === 4);
  check('credentials strip: B-BBEE, SABS/SANS and Proudly South African on one line', await evaluate('(() => { const s = document.querySelector(".hero + .credentials"); if (!s) return false; const items = [...s.querySelectorAll(".credentials-list li")]; const tops = items.map(li => Math.round(li.getBoundingClientRect().top)); return items.length === 3 && new Set(tops).size === 1 && /B-BBEE/.test(items[0].textContent) && /SABS/.test(items[1].textContent) && /Proudly South African/.test(items[2].textContent); })()'));
  check('credentials show the B-BBEE, SABS and Proudly South African logos', await evaluate('(() => { const imgs = [...document.querySelectorAll(".credentials-list img.cred-logo")]; return imgs.length === 3 && imgs.every(i => i.complete && i.naturalWidth > 0) && /b-bbee/.test(imgs[0].src) && /sabs/.test(imgs[1].src) && /proudly-south-african/.test(imgs[2].src); })()'));
  check('hero fact row removed', !(await evaluate('!!document.querySelector(".hero-facts")')));
  check('estimator steps sit side by side on desktop', await evaluate('(() => { const a = document.querySelector("#quantity-step").getBoundingClientRect(), b = document.querySelector("#cost-title").closest("section").getBoundingClientRect(); return Math.abs(a.top - b.top) < 2 && b.left > a.right - 1; })()'));

  // ---- Quantity ↔ slider ↔ visualiser ↔ cost ----
  await type('[data-qty-input]', '250,000');
  check('typed quantity syncs the slider', (await evaluate('document.querySelector("[data-qty-range]").value')) === String(require('../../shared/quantity.js').quantityToSlider(250000)));
  check('cost estimate uses R0.30 × quantity', (await text('[data-cost-total]')) === 'R75,000.00' && (await text('[data-cost-unit]')) === 'R0.30');
  check('pricing tier shown', (await text('[data-cost-tier]')) === 'Pallet supply');
  check('pads = packs: packs box follows typed pads', (await evaluate('document.querySelector("[data-pack-input]").value')) === '25,000');
  check('tally above the estimator shows Pads = and Packs =', (await text('[data-tally-pads]')) === '250,000' && (await text('[data-tally-packs]')) === '25,000');
  check('"You asked for 25,000 packs = R75,000.00"', (await text('.cost-result-main')) === '25,000 packs = R75,000.00'
    && /This is the base price for 25,000 packs \(250,000 pads\) at R3\.00 per pack\./.test(await text('[data-cost-base]')));
  await type('[data-pack-input]', '1,200');
  check('typing packs sets single pads (1,200 packs = 12,000 pads)', (await evaluate('document.querySelector("[data-qty-input]").value')) === '12,000'
    && (await text('.cost-result-main')) === '1,200 packs = R3,600.00');
  await type('[data-qty-input]', '25');
  check('single pads that are not a full pack are shown', (await evaluate('document.querySelector("[data-pack-input]").value')) === '2' && /2 packs \+ 5 single pads/.test(await text('[data-qty-loose]')));
  await type('[data-qty-input]', '250,000');
  check('price defaults to R0.30 per pad and R3.00 per pack', (await evaluate('document.querySelector("[data-price-input]").value')) === '0.30' && (await evaluate('document.querySelector("[data-pack-price-input]").value')) === '3.00');
  await type('[data-price-input]', '0.35');
  check('typed price per pad updates slider, price per pack and total',
    (await evaluate('document.querySelector("[data-price-range]").value')) === '35'
    && (await evaluate('document.querySelector("[data-pack-price-input]").value')) === '3.50'
    && (await text('[data-cost-total]')) === 'R87,500.00');
  await type('[data-pack-price-input]', '4.00');
  check('typed price per pack sets the price per pad', (await evaluate('document.querySelector("[data-price-input]").value')) === '0.40' && (await text('[data-cost-total]')) === 'R100,000.00');
  await evaluate('(() => { const r = document.querySelector("[data-price-range]"); r.value = "25"; r.dispatchEvent(new Event("input", { bubbles: true })); })()');
  check('dragging the price updates both inputs and flags prices below ours',
    (await evaluate('document.querySelector("[data-price-input]").value')) === '0.25'
    && (await evaluate('document.querySelector("[data-pack-price-input]").value')) === '2.50'
    && /below our current price/.test(await text('[data-cost-compare]')));
  await type('[data-price-input]', '0.30');
  check('visualiser shows the pallet tier', (await evaluate('document.querySelector("[data-visual-tier]").dataset.tier')) === 'pallet');
  check('pallet tier shows the supplied photo', await waitFor('(() => { const i = document.querySelector("[data-visual-tier] img"); return !!i && /pallets\\.webp/.test(i.src) && i.complete && i.naturalWidth > 0; })()'));
  check('cost estimator contains no imagery', (await evaluate('document.querySelector("#cost-title").closest("section").querySelectorAll("img,svg").length')) === 0);

  await evaluate('(() => { const r = document.querySelector("[data-qty-range]"); r.value = "1000"; r.dispatchEvent(new Event("input", { bubbles: true })); })()');
  check('slider syncs the typed quantity with separators', (await evaluate('document.querySelector("[data-qty-input]").value')) === '1,000,000');
  check('visualiser shows large-scale supply at 1,000,000', (await evaluate('document.querySelector("[data-visual-tier]").dataset.tier')) === 'large-scale');
  check('+ disabled at the maximum', await evaluate('document.querySelector("[data-qty-step=\\"1\\"]").disabled'));

  await type('[data-qty-input]', '0');
  check('zero quantity shows no price', (await text('[data-cost-total]')) === '—' && !(await evaluate('document.querySelector("[data-cost-empty]").hidden')));
  await click('[data-qty-step="1"]');
  check('+ increments from zero', (await evaluate('document.querySelector("[data-qty-input]").value')) === '100');

  // ---- Gallery ----
  await click('[data-gallery-toggle]');
  check('gallery expands', (await evaluate('document.querySelector("[data-gallery-toggle]").getAttribute("aria-expanded")')) === 'true'
    && !(await evaluate('document.querySelector("[data-gallery-region]").hidden'))
    && (await evaluate('document.querySelectorAll("[data-gallery-tier]").length')) === 6);
  check('every supply volume in the gallery shows a photo', await waitFor('(() => { const imgs = [...document.querySelectorAll("[data-gallery-tier] img")]; return imgs.length === 6 && imgs.every(i => i.complete && i.naturalWidth > 0); })()'));
  await click('[data-gallery-tier="multiple-packs"]');
  check('gallery item sets the quantity', (await evaluate('document.querySelector("[data-qty-input]").value')) === '10,000');
  check('product panel shows the supplied photo', await evaluate('(() => { const i = document.querySelector("[data-visual-product] img"); return !!i && /product-pads\\.webp/.test(i.src); })()'));
  check('multiple packs shows the supplied photo', await waitFor('(() => { const i = document.querySelector("[data-visual-tier] img"); return !!i && /multiple-packs\\.webp/.test(i.src) && i.complete && i.naturalWidth > 0; })()'));
  await screenshot('desktop-estimator-gallery');
  await click('[data-gallery-toggle]');

  // ---- Requirements + Stage 1 ----
  await type('[data-qty-input]', '25000');
  check('packaging explains plain white heat-sealed packs and no printing', /heat-sealed in plain white plastic/.test(await text('.pack-spec')) && /we do not print/.test(await text('.pack-note')));
  await click('[data-req="packaging"]');
  await click('[data-req="collect"]');
  check('ticking collection disables the delivery point', await evaluate('document.querySelector("[data-req=deliveryPoint]").disabled'));
  await click('[data-req="collect"]');
  await type('[data-req="deliveryPoint"]', 'Polokwane district depot');
  await click('[data-save-draft]');
  check('qualifying answer is required before saving', /Choose what best describes you/.test(await text('[data-stage1-error]')) && store.list().length === 0);
  check('progress starts at 0%', /^0%/.test(await text('[data-progress-text]')));

  await click('input[name="leadType"][value="tender-secured"]');
  await click('[data-save-draft]');
  check('stage 1 saves a draft and shows stage 2', await waitFor('!document.querySelector("[data-stage2]").hidden'));
  check('green "Requirements saved — 50% complete" note after Save and continue', !(await evaluate('document.querySelector("[data-stage1-success]").hidden')) && /Requirements saved — 50% complete/.test(await text('[data-stage1-success]')));
  check('no bot check shown when Turnstile is off', await evaluate('document.querySelector("[data-turnstile]").hidden'));
  check('progress shows 50%', /^50%/.test(await text('[data-progress-text]')));
  const draft = store.list()[0];
  check('draft stored server-side with a PLH reference', draft && draft.status === 'DRAFT' && /^PLH-[0-9A-F]{8}$/.test(draft.id));
  check('draft captured stickers, delivery point and qualifying answer', draft?.requirements.packaging && draft?.requirements.delivery && draft?.requirements.deliveryPoint === 'Polokwane district depot' && draft?.requirements.leadType === 'tender-secured');
  check('summary shows the delivery point', (await text('[data-summary="delivery"]')) === 'To Polokwane district depot');
  check('summary shows the estimate', (await text('[data-summary="total"]')) === 'R7,500.00');
  check('summary shows price per pack of 10', (await text('[data-summary="pack"]')) === 'R3.00' && /2,500 packs of 10/.test(await text('[data-summary="quantity"]')));

  // ---- Going back to adjust keeps the same draft ----
  await type('[data-qty-input]', '40000');
  check('edited quantity syncs to the saved draft', await waitFor('document.querySelector("[data-sync-status]").dataset.status === "saved"', 5000)
    && store.get(draft.id).requirements.quantity === 40000);
  await goto(`${BASE}/`);
  check('draft survives a page refresh', await waitFor('!document.querySelector("[data-stage2]").hidden')
    && (await evaluate('document.querySelector("[data-qty-input]").value')) === '40,000');

  // ---- Stage 2 ----
  await type('[name="fullName"]', 'Thandi Mokoena');
  await type('[name="location"]', 'Polokwane');
  await type('[name="email"]', 'not-an-email');
  await click('[name="privacyConsent"]');
  await click('[data-submit-enquiry]');
  check('invalid email is flagged and nothing is submitted', !(await evaluate('document.querySelector("[data-error-for=email]").hidden')) && store.get(draft.id).status === 'DRAFT');
  check('progress stays at 50% until the server accepts', /^50%/.test(await text('[data-progress-text]')));

  await type('[name="email"]', 'thandi@example.co.za');
  await evaluate('(() => { const b = document.querySelector("[data-submit-enquiry]"); b.click(); b.click(); b.click(); })()');
  check('confirmation appears', await waitFor('!document.querySelector("[data-confirmation]").hidden', 6000));
  check('confirmation gives the contact email', await evaluate('document.querySelector(".confirm-contact a").getAttribute("href") === "mailto:Nextgeneration.ai7.0@gmail.com"'));
  check('confirmation shows the draft reference', (await text('[data-confirmation-reference]')) === draft.id);
  check('confirmation message wording', /Thank you for choosing PureLine Hygiene\. Your enquiry has been received and will be reviewed by our team\. Your reference number is PLH-/.test(await text('.confirm-message')));
  check('green success banner after submission', /Successfully submitted\. We will contact you after our team has reviewed your enquiry\./.test(await text('.success-banner')) && (await evaluate('getComputedStyle(document.querySelector(".success-banner")).color')) === 'rgb(31, 122, 77)');
  check('progress shows 100%', /^100%/.test(await text('[data-progress-text]')));
  const final = store.get(draft.id);
  check('lead is SUBMITTED with contact details and preserved draft', final.status === 'SUBMITTED' && final.contact.email === 'thandi@example.co.za' && final.draftSnapshot.quantity === 25000);
  check('triple-click produced one lead', store.list().length === 1 && final.history.filter((h) => h.event === 'SUBMITTED').length === 1);
  check('edit token cleared from the browser after submission', (await evaluate('sessionStorage.getItem("pureline-enquiry")')) === null);
  await screenshot('desktop-confirmation');

  // ---- Hero image + removed sections ----
  check('removed sections are gone (Solutions, Quality, Process, landing FAQs, Contact)', (await evaluate('!document.querySelector("#solutions, #faqs, #contact, #quality-title, #process-title")')));
  check('hero shows the logistics image behind the copy', (await evaluate('!!document.querySelector(".hero [data-logistics-scene] svg")')) && !(await evaluate('!!document.querySelector(".distribution")')));
  check('footer: PURELINE HYGIENE on the left, business email link on the right', await evaluate('(() => { const b = document.querySelector(".footer-brand").getBoundingClientRect(), e = document.querySelector(".footer-email"); const r = e.getBoundingClientRect(); return document.querySelector(".footer-brand").textContent === "PURELINE HYGIENE" && e.getAttribute("href") === "mailto:Nextgeneration.ai7.0@gmail.com" && e.textContent === "Nextgeneration.ai7.0@gmail.com" && r.left > b.right && Math.abs(r.right - document.querySelector(".footer-inner").getBoundingClientRect().right) < 2; })()'));


  // ---- FAQ page ----
  await goto(`${BASE}/faq.html`);
  const faqCount = await evaluate('document.querySelectorAll(".faq-category details").length');
  check('FAQ page keeps a short, categorised list', faqCount >= 15 && faqCount <= 25 && (await evaluate('document.querySelectorAll(".faq-category").length')) === 6, `${faqCount} questions`);
  check('FAQ privacy answer gives the contact email', await evaluate('!!document.querySelector("#privacy a[href=\\"mailto:Nextgeneration.ai7.0@gmail.com\\"]")'));
  check('FAQ page links back to the landing page', await evaluate('!!document.querySelector(".back-link a[href=\\"index.html\\"]")'));
  await click('.faq-category details summary');
  check('FAQ accordion opens', await evaluate('document.querySelector(".faq-category details").open'));
  await screenshot('desktop-faq');

  // ---- Mobile ----
  await viewport(390, 844, true);
  await goto(`${BASE}/`);
  check('no horizontal scrolling on mobile', await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
    String(await evaluate('document.documentElement.scrollWidth')));
  check('We Specialise In sits between the hero and the estimator on mobile', await evaluate('!!document.querySelector(".hero + .credentials") && document.querySelector(".credentials").getBoundingClientRect().top < document.querySelector(".estimator").getBoundingClientRect().top'));
  await click('.menu-toggle');
  check('mobile menu opens', await evaluate('getComputedStyle(document.querySelector(".main-nav")).display !== "none"'));
  await click('.menu-toggle');
  await screenshot('mobile-home');
  await shotElement('mobile-hero', '.hero');
  await shotElement('mobile-credentials', '.credentials');
  await shotElement('mobile-estimator', '#calculator');
  await goto(`${BASE}/faq.html`);
  check('no horizontal scrolling on the mobile FAQ page', await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));

  check('no JavaScript errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  check('e2e run completed', false, error.stack);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(1000);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.log(`(Could not remove ${profile} yet; Chrome may still be closing. It is git-ignored.)`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed. Screenshots: ${OUTPUT}`);
process.exit(failed.length ? 1 : 0);
