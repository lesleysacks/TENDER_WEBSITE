'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { FileLeadStore } = require('../server/lead-store');
const { createLeadService } = require('../server/lead-service');

const ROOT = path.resolve(__dirname, '..');
const REQUIREMENTS = { quantity: 25000, targetUnitPriceCents: 35, packaging: true, delivery: true, leadType: 'tender-secured' };
const CONTACT = {
  fullName: 'Thandi Mokoena',
  company: 'Example Municipality Supplier (Pty) Ltd',
  location: 'Polokwane',
  email: 'thandi@example.co.za',
  phone: '+27 82 000 0000',
  privacyConsent: true,
  whatsappConsent: true,
};

async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-api-'));
  const file = path.join(dir, 'leads.json');
  const store = await new FileLeadStore(file).init();
  const events = [];
  const notifier = { leadEvent: async (event, lead) => events.push({ event, id: lead.id }) };
  const leadService = createLeadService({ store, notifier, logger: { error() {} } });
  const server = createApp({ rootDir: ROOT, leadService, logger: { error() {} }, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { body, token, headers = {} } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Lead-Token': token } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* static file */ }
    return { status: response.status, json, text, headers: response.headers };
  };

  return { server, store, events, call, file, close: () => new Promise((r) => server.close(r)) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('full two-stage journey: draft (50%) then submission (100%)', async (t) => {
  const app = await startServer();
  t.after(app.close);

  // Stage 1: the browser's prices are ignored; the server recalculates them.
  const created = await app.call('POST', '/api/leads', {
    body: { requirements: { ...REQUIREMENTS, unitPriceCents: 1, totalCents: 1, targetTotalCents: 1 }, idempotencyKey: 'k-1' },
  });
  assert.equal(created.status, 201);
  const { lead, editToken } = created.json;
  assert.match(lead.reference, /^PLH-[0-9A-F]{8}$/);
  assert.equal(lead.status, 'DRAFT');
  assert.equal(lead.requirements.unitPriceCents, 30);
  assert.equal(lead.requirements.totalCents, 750000);
  // Customer's chosen price: R0.35 per pad → R3.50 per pack of 10 → 25,000 × R0.35 = R8,750.00
  assert.equal(lead.requirements.packs, 2500);
  assert.equal(lead.requirements.targetUnitPriceCents, 35);
  assert.equal(lead.requirements.targetPackPriceCents, 350);
  assert.equal(lead.requirements.targetTotalCents, 875000);
  assert.ok(editToken);

  const stored = app.store.get(lead.reference);
  assert.equal(stored.status, 'DRAFT');
  assert.ok(stored.createdAt);
  assert.ok(stored.uuid);
  assert.equal(stored.draftSnapshot.quantity, 25000);
  assert.notEqual(stored.editTokenHash, editToken, 'token is stored hashed');

  // Going back to adjust the quantity updates the same draft.
  const patched = await app.call('PATCH', `/api/leads/${lead.reference}`, {
    token: editToken,
    body: { requirements: { ...REQUIREMENTS, quantity: 40000, packaging: false, deliveryPoint: '  Polokwane depot ' } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.lead.requirements.deliveryPoint, 'Polokwane depot');
  assert.equal(patched.json.lead.requirements.totalCents, 1200000);

  // Draft can be restored after a refresh.
  const restored = await app.call('GET', `/api/leads/${lead.reference}`, { token: editToken });
  assert.equal(restored.json.lead.requirements.quantity, 40000);

  // Stage 2.
  const submitted = await app.call('POST', `/api/leads/${lead.reference}/submit`, { token: editToken, body: { contact: CONTACT } });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.lead.reference, lead.reference);
  assert.equal(submitted.json.lead.status, 'SUBMITTED');
  assert.equal(submitted.json.alreadySubmitted, false);
  assert.equal(submitted.json.lead.contact, undefined, 'contact details are not echoed back');

  const final = app.store.get(lead.reference);
  assert.equal(final.status, 'SUBMITTED');
  assert.ok(final.submittedAt);
  assert.equal(final.contact.email, 'thandi@example.co.za');
  assert.equal(final.draftSnapshot.quantity, 25000, 'original draft is preserved');
  assert.equal(final.submittedRequirements.quantity, 40000);
  assert.deepEqual(final.history.map((h) => h.event), ['DRAFT_SAVED', 'REQUIREMENTS_UPDATED', 'SUBMITTED']);
  assert.equal(final.consent.whatsappFollowUp, true);

  // Persisted to disk.
  const onDisk = JSON.parse(fs.readFileSync(app.file, 'utf8'));
  assert.equal(onDisk.leads[lead.reference].status, 'SUBMITTED');

  await settle();
  assert.deepEqual(app.events.map((e) => e.event), ['lead.draft_saved', 'lead.submitted']);
});

test('duplicate submissions are idempotent and notify only once', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const { json } = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS } });
  const ref = json.lead.reference;

  const results = await Promise.all(
    [1, 2, 3].map(() => app.call('POST', `/api/leads/${ref}/submit`, { token: json.editToken, body: { contact: CONTACT } }))
  );
  results.forEach((r) => {
    assert.equal(r.status, 200);
    assert.equal(r.json.lead.reference, ref);
  });
  assert.equal(results.filter((r) => r.json.alreadySubmitted === false).length, 1);

  // Changing requirements after submission is refused.
  const late = await app.call('PATCH', `/api/leads/${ref}`, { token: json.editToken, body: { requirements: REQUIREMENTS } });
  assert.equal(late.status, 409);

  await settle();
  assert.equal(app.events.filter((e) => e.event === 'lead.submitted').length, 1);
});

test('retrying draft creation with the same idempotency key returns the same draft', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const body = { requirements: REQUIREMENTS, idempotencyKey: 'retry-key' };
  const first = await app.call('POST', '/api/leads', { body });
  const second = await app.call('POST', '/api/leads', { body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.lead.reference, first.json.lead.reference);
  assert.equal(app.store.list().length, 1);
});

test('drafts cannot be read or changed without the edit token', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const { json } = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS } });
  const ref = json.lead.reference;

  assert.equal((await app.call('GET', `/api/leads/${ref}`)).status, 404);
  assert.equal((await app.call('GET', `/api/leads/${ref}`, { token: 'wrong' })).status, 404);
  assert.equal((await app.call('POST', `/api/leads/${ref}/submit`, { token: 'wrong', body: { contact: CONTACT } })).status, 404);
  assert.equal((await app.call('GET', '/api/leads/PLH-00000000', { token: json.editToken })).status, 404);
});

test('validation errors are reported per field', async (t) => {
  const app = await startServer();
  t.after(app.close);

  const zero = await app.call('POST', '/api/leads', { body: { requirements: { ...REQUIREMENTS, quantity: 0 } } });
  assert.equal(zero.status, 422);
  assert.ok(zero.json.errors.quantity);

  const noType = await app.call('POST', '/api/leads', { body: { requirements: { ...REQUIREMENTS, leadType: '' } } });
  assert.ok(noType.json.errors.leadType);

  const { json } = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS } });
  const bad = await app.call('POST', `/api/leads/${json.lead.reference}/submit`, {
    token: json.editToken,
    body: { contact: { ...CONTACT, email: 'nope', privacyConsent: false } },
  });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.errors.email);
  assert.ok(bad.json.errors.privacyConsent);
  assert.equal(app.store.get(json.lead.reference).status, 'DRAFT', 'invalid submission leaves the draft intact');

  assert.equal((await app.call('POST', '/api/leads', { body: [] })).status, 400);
  const notJson = await fetch(`http://127.0.0.1:${app.server.address().port}/api/leads`, { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(notJson.status, 415);
  const huge = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS, padding: 'x'.repeat(20000) } });
  assert.equal(huge.status, 413);
});

test('spam protection: honeypot, cross-site origin and rate limiting', async (t) => {
  const app = await startServer({ rateLimits: { create: { max: 3 } } });
  t.after(app.close);

  const bot = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS, website: 'http://spam' } });
  assert.equal(bot.status, 400);
  assert.equal(app.store.list().length, 0);

  const crossSite = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS }, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);

  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS } })).status);
  assert.deepEqual(statuses, [201, 201, 429, 429]);
});

test('CORS: allowed dev origin (Live Server) can save drafts; others cannot', async (t) => {
  const app = await startServer({ allowedOrigins: ['http://127.0.0.1:5500'] });
  t.after(app.close);

  const preflight = await app.call('OPTIONS', '/api/leads', {
    headers: { Origin: 'http://127.0.0.1:5500', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5500');
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Lead-Token/);

  const created = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS }, headers: { Origin: 'http://127.0.0.1:5500' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5500');

  const other = await app.call('OPTIONS', '/api/leads', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('Turnstile: submissions need a valid bot-check token when enabled', async (t) => {
  const seen = [];
  const turnstile = { enabled: true, siteKey: 'site-key-123', verify: async (token, ip) => { seen.push(ip); return token === 'good-token'; } };
  const app = await startServer({ turnstile });
  t.after(app.close);

  const config = await app.call('GET', '/api/config');
  assert.equal(config.json.turnstileSiteKey, 'site-key-123');
  const page = await app.call('GET', '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/challenges\.cloudflare\.com/);

  const { json } = await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS } });
  const submit = (turnstileToken) =>
    app.call('POST', `/api/leads/${json.lead.reference}/submit`, { token: json.editToken, body: { contact: CONTACT, turnstileToken } });

  assert.equal((await submit(undefined)).status, 403);
  assert.equal((await submit('forged')).status, 403);
  assert.equal(app.store.get(json.lead.reference).status, 'DRAFT');
  const ok = await submit('good-token');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lead.status, 'SUBMITTED');
  assert.ok(seen.every((ip) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1'));
});

test('Turnstile off by default: no extra script allowed, no site key exposed', async (t) => {
  const app = await startServer();
  t.after(app.close);
  assert.equal((await app.call('GET', '/api/config')).json.turnstileSiteKey, null);
  assert.doesNotMatch((await app.call('GET', '/')).headers.get('content-security-policy'), /cloudflare/);
});

test('global rate limit caps a spam wave spread across many addresses', async (t) => {
  const app = await startServer({ trustProxy: 'cloudflare', rateLimits: { create: { max: 100 }, globalCreate: { max: 3 } } });
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    statuses.push((await app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS }, headers: { 'CF-Connecting-IP': `203.0.113.${i}` } })).status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
});

test('behind Cloudflare each visitor gets their own rate limit (CF-Connecting-IP)', async (t) => {
  const app = await startServer({ trustProxy: 'cloudflare', rateLimits: { create: { max: 1 } } });
  t.after(app.close);
  const post = (ip) => app.call('POST', '/api/leads', { body: { requirements: REQUIREMENTS }, headers: { 'CF-Connecting-IP': ip } });
  assert.equal((await post('198.51.100.1')).status, 201);
  assert.equal((await post('198.51.100.1')).status, 429);
  assert.equal((await post('198.51.100.2')).status, 201, 'a different visitor is not blocked');
});

test('static site is served; lead data and server code are not', async (t) => {
  const app = await startServer();
  t.after(app.close);

  const home = await app.call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Congratulations on securing your tender!/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await app.call('GET', '/faq.html')).status, 200);
  assert.equal((await app.call('GET', '/shared/pricing.js')).status, 200);

  for (const blocked of ['/data/leads.json', '/server/app.js', '/package.json', '/tests/api.test.js', '/.gitignore', '/css/../server/app.js', '/css/%2e%2e/server/app.js']) {
    assert.equal((await app.call('GET', blocked)).status, 404, blocked);
  }
});
