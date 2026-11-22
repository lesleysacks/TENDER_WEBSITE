'use strict';

/*
 * Tests for the Google Apps Script backend (dist/apps-script/Code.gs), run in Node against
 * in-memory stand-ins for Sheets, Drive, Docs, Gmail and the other Google services.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadAppsScript } = require('./support/gas-fakes');
const M = require('../shared/lead-messages');

const REQUIREMENTS = { quantity: 12000, targetUnitPriceCents: 30, packaging: true, delivery: true, deliveryPoint: 'Polokwane depot', leadType: 'tender-secured' };
const CONTACT = { fullName: 'Thandi Mokoena', company: 'Thandi Supplies', location: 'Polokwane', email: 'thandi@example.co.za', phone: '+27 82 123 4567', privacyConsent: true, whatsappConsent: true };

function ready(options) {
  const t = loadAppsScript({ ownerEmail: 'admin@example.com', ...options });
  t.gas.setup();
  t.leads = t.spreadsheet.getSheetByName('Leads');
  // These lifecycle tests act like a person who took their time (tests/security.test.js covers the timing checks).
  t.gas.LIMITS.minMsDraftToSubmit = 0;
  const post = t.post;
  t.post = (body) => post(body && typeof body === 'object' && body.action === 'create' && body.elapsedMs === undefined ? { ...body, elapsedMs: 20000 } : body);
  return t;
}

test('the committed Code.gs matches the sources (run npm run build:apps-script after changes)', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-apps-script.js'), '--check'], { stdio: 'pipe' });
});

test('setup builds the tabs, the Leads columns, settings, templates and the daily clean-up', () => {
  const t = ready();
  assert.deepEqual(t.spreadsheet.getSheets().map((s) => s.getName()), ['Dashboard', 'Leads', 'Settings', 'How to use', 'Chart data']);
  assert.deepEqual(t.leads.raw[0].slice(0, M.REGISTER_COLUMNS.length), M.REGISTER_COLUMNS);
  assert.equal(t.spreadsheet.getSheetByName('Settings').rowObject(2).Setting, 'Notification email');
  assert.equal(t.spreadsheet.getSheetByName('Settings').cell(2, 2), 'admin@example.com', 'notifications go to the account that runs setup');
  for (const key of ['FOLDER_ID', 'QUOTES_FOLDER_ID', 'QUOTE_TEMPLATE_ID', 'EMAIL_TEMPLATES_ID', 'START_HERE_ID']) assert.ok(t.properties.get(key), key);
  const template = t.docs.get(t.properties.get('QUOTE_TEMPLATE_ID'));
  assert.match(template.text(), /\{\{Quantity \(pads\)\}\}/);
  assert.deepEqual(t.triggers, ['purgeDrafts']);
  const dashboard = t.spreadsheet.getSheetByName('Dashboard');
  assert.match(String(dashboard.cell(5, 1)), /^=HYPERLINK\(/);
  assert.match(String(dashboard.cell(5, 4)), /COUNTIF\('Leads'!B:B,"Submitted"\)/);

  // Dashboard charts read live formulas on the Chart data tab
  const data = t.spreadsheet.getSheetByName('Chart data');
  assert.equal(data.cell(3, 1), 'Status');
  assert.equal(data.cell(4, 1), 'Submitted');
  assert.equal(data.cell(4, 2), "=COUNTIF('Leads'!B:B,A4)");
  assert.equal(data.cell(3, 7), 'Month');
  assert.match(String(data.cell(4, 9)), /^=SUMIFS\('Leads'!L:L,'Leads'!C:C,">="&G4/);
  assert.equal(data.cell(5, 16), 'Plain white packs');
  assert.equal(dashboard.getCharts().length, 6);
  assert.deepEqual(dashboard.getCharts().map((c) => c.ranges.map((r) => `${r.row},${r.col},${r.rows},${r.cols}`).join(' ')),
    ['3,1,7,2', '3,4,5,2', '3,7,7,1 3,8,7,1', '3,7,7,1 3,9,7,1', '3,13,3,2', '3,16,3,2']);

  // Running setup again keeps data and does not add a second trigger or new documents.
  const ids = [...t.properties.values()].join();
  t.post({ action: 'create', requirements: REQUIREMENTS });
  t.gas.setup();
  assert.equal(t.leads.getLastRow(), 2);
  assert.deepEqual(t.triggers, ['purgeDrafts']);
  assert.equal([...t.properties.values()].join(), ids);
  assert.equal(dashboard.getCharts().length, 6, 'charts are replaced, not duplicated');
});

test('draft → update → submit, with prices recalculated and both emails sent once', () => {
  const t = ready();
  const created = t.post({ action: 'create', requirements: { ...REQUIREMENTS, targetTotalCents: 1 }, idempotencyKey: 'key-00000001' });
  assert.equal(created.status, 200);
  assert.match(created.lead.reference, /^PLH-[0-9A-F]{8}$/);
  assert.equal(created.lead.status, 'DRAFT');
  assert.equal(created.lead.requirements.targetTotalCents, 360000, 'browser totals are ignored');
  assert.equal(t.leads.rowObject(2).Status, 'Draft');
  assert.notEqual(t.leads.rowObject(2)._tokenHash, created.editToken, 'token is stored hashed');

  const again = t.post({ action: 'create', requirements: REQUIREMENTS, idempotencyKey: 'key-00000001' });
  assert.equal(again.lead.reference, created.lead.reference, 'a double click reuses the same draft');
  assert.equal(t.leads.getLastRow(), 2);

  const ref = created.lead.reference;
  const token = created.editToken;
  const updated = t.post({ action: 'update', ref, token, requirements: { ...REQUIREMENTS, quantity: 25005 } });
  assert.equal(updated.lead.requirements.quantity, 25005);
  assert.equal(t.leads.rowObject(2)['Single pads'], 5);
  assert.equal(t.post({ action: 'get', ref, token }).lead.requirements.quantity, 25005);

  const invalid = t.post({ action: 'submit', ref, token, contact: { ...CONTACT, email: 'nope' } });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.errors.email);
  assert.equal(t.sent.length, 0);

  const submitted = t.post({ action: 'submit', ref, token, contact: CONTACT });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.lead.status, 'SUBMITTED');
  assert.equal(submitted.alreadySubmitted, false);
  const row = t.leads.rowObject(2);
  assert.equal(row.Status, 'Submitted');
  assert.equal(row.Name, 'Thandi Mokoena');
  assert.equal(row['WhatsApp OK'], 'Yes');
  assert.equal(row['Delivery point'], 'Polokwane depot');
  assert.equal(row['Customer total'], 7501.5);
  assert.equal(typeof row.Submitted.toISOString, 'function', 'dates are real dates');

  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0].to, 'admin@example.com');
  assert.equal(t.sent[0].replyTo, 'thandi@example.co.za');
  assert.match(t.sent[0].body, /WhatsApp follow-up permitted: Yes/);
  assert.equal(t.sent[1].to, 'thandi@example.co.za');
  assert.match(t.sent[1].body, new RegExp(ref));

  const repeat = t.post({ action: 'submit', ref, token, contact: CONTACT });
  assert.equal(repeat.alreadySubmitted, true);
  assert.equal(t.sent.length, 2, 'no second set of emails');
  assert.equal(t.post({ action: 'update', ref, token, requirements: REQUIREMENTS }).status, 409);
});

test('wrong tokens, unknown references and bad requests are refused', () => {
  const t = ready();
  const created = t.post({ action: 'create', requirements: REQUIREMENTS });
  const ref = created.lead.reference;
  assert.equal(t.post({ action: 'get', ref, token: 'wrong' }).status, 404);
  assert.equal(t.post({ action: 'get', ref: 'PLH-00000000', token: created.editToken }).status, 404);
  assert.equal(t.post({ action: 'get', ref: 'nonsense', token: created.editToken }).status, 404);
  assert.equal(t.post({ action: 'get', ref }).status, 404);
  assert.equal(t.post({ action: 'create', requirements: { ...REQUIREMENTS, quantity: 0 } }).status, 422);
  assert.equal(t.post({ action: 'delete' }).status, 400);
  assert.equal(t.post('not json').status, 400);
  assert.equal(t.post('x'.repeat(17 * 1024)).status, 413);
  assert.equal(t.post({ action: 'config' }).turnstileSiteKey, null);
  assert.equal(JSON.parse(t.gas.doGet().getContent()).ok, true);
});

test('spam protection: honeypot and hourly caps', () => {
  const t = ready();
  assert.equal(t.post({ action: 'create', requirements: REQUIREMENTS, website: 'http://spam.example' }).status, 400);
  t.gas.LIMITS.draftsPerHour = 2;
  assert.equal(t.post({ action: 'create', requirements: REQUIREMENTS }).status, 200);
  assert.equal(t.post({ action: 'create', requirements: REQUIREMENTS }).status, 200);
  assert.equal(t.post({ action: 'create', requirements: REQUIREMENTS }).status, 429);
  assert.equal(t.leads.getLastRow(), 3);

  const t2 = ready();
  const draft = t2.post({ action: 'create', requirements: REQUIREMENTS });
  const honeypot = t2.post({ action: 'submit', ref: draft.lead.reference, token: draft.editToken, contact: CONTACT, website: 'x' });
  assert.equal(honeypot.status, 400);
  assert.equal(t2.sent.length, 0);
});

test('text that looks like a formula is stored as plain text', () => {
  const t = ready();
  const draft = t.post({ action: 'create', requirements: REQUIREMENTS });
  t.post({ action: 'submit', ref: draft.lead.reference, token: draft.editToken, contact: { ...CONTACT, fullName: '=HYPERLINK("http://evil")' } });
  const nameColumn = M.REGISTER_COLUMNS.indexOf('Name');
  assert.equal(t.leads.raw[1][nameColumn], `'=HYPERLINK("http://evil")`);
});

test('staff edits survive: status, notes and quote link are never overwritten', () => {
  const t = ready();
  t.properties.set('SHARED_SECRET', 'shh');
  const lead = {
    id: 'PLH-0000000A', status: 'SUBMITTED', createdAt: '2026-11-20T08:00:00.000Z', submittedAt: '2026-11-20T08:05:00.000Z',
    requirements: { quantity: 100, packs: 10, unitPriceCents: 30, totalCents: 3000, targetUnitPriceCents: 30, targetPackPriceCents: 300, targetTotalCents: 3000, packaging: false, delivery: true, deliveryPoint: '', leadType: 'bulk' },
    contact: { fullName: 'A Buyer', company: '', location: 'Durban', email: 'buyer@example.co.za', phone: '' },
    consent: { whatsappFollowUp: false },
  };
  // The optional Node server sends signed rows; the script upserts them.
  const send = (row, emails = []) => {
    const payload = JSON.stringify({ event: 'lead.submitted', row, emails });
    const signature = crypto.createHmac('sha256', 'shh').update(payload).digest('hex');
    return t.post({ payload, signature });
  };
  assert.equal(send(M.toLeadRegisterRow(lead)).status, 200);
  assert.equal(t.leads.rowObject(2).Status, 'Submitted');
  t.leads.getRange(2, M.REGISTER_COLUMNS.indexOf('Status') + 1).setValue('Under Review');
  t.leads.getRange(2, M.REGISTER_COLUMNS.indexOf('Staff notes') + 1).setValue('Called on Monday');
  send(M.toLeadRegisterRow(lead));
  assert.equal(t.leads.rowObject(2).Status, 'Under Review');
  assert.equal(t.leads.rowObject(2)['Staff notes'], 'Called on Monday');
  assert.equal(t.leads.getLastRow(), 2);
  assert.equal(t.post({ payload: '{}', signature: 'bad' }).status, 403);
});

test('expired drafts are purged; submitted enquiries are kept', () => {
  const t = ready();
  const old = t.post({ action: 'create', requirements: REQUIREMENTS });
  const kept = t.post({ action: 'create', requirements: REQUIREMENTS });
  t.post({ action: 'submit', ref: kept.lead.reference, token: kept.editToken, contact: CONTACT });
  const updatedColumn = M.REGISTER_COLUMNS.length + 2; // _updatedAt
  const createdColumn = M.REGISTER_COLUMNS.indexOf('Created') + 1;
  const longAgo = new Date(Date.now() - 31 * 864e5);
  t.leads.getRange(2, updatedColumn).setValue(longAgo.toISOString());
  t.leads.getRange(2, createdColumn).setValue(longAgo);
  assert.equal(t.gas.purgeDrafts(), 1);
  assert.equal(t.leads.getLastRow(), 2);
  assert.equal(t.leads.rowObject(2)['Lead ID'], kept.lead.reference);
  assert.notEqual(t.leads.rowObject(2)['Lead ID'], old.lead.reference);
});

test('a quotation is created from the template with every placeholder filled', () => {
  const t = ready();
  const settings = t.spreadsheet.getSheetByName('Settings');
  assert.equal(settings.cell(8, 1), 'Bank name');
  settings.getRange(8, 2).setValue('First National Bank');
  t.gas.settingsCache_ = null; // each real Apps Script run starts with a fresh cache
  const draft = t.post({ action: 'create', requirements: REQUIREMENTS });
  t.post({ action: 'submit', ref: draft.lead.reference, token: draft.editToken, contact: CONTACT });
  const record = t.gas.rowObject_(t.leads.getRange(2, 1, 1, 31).getValues()[0]);
  const url = t.gas.createQuotationForRow_(t.leads, 2, record);
  const quote = [...t.docs.values()].find((d) => d.name.startsWith(`Quotation ${draft.lead.reference}`));
  assert.ok(quote, 'copy saved in Quotes');
  const text = quote.text();
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, /12,000 pads \(1,200 packs of 10\)/);
  assert.match(text, /R0\.30 per pad \(R3\.00 per pack\)/);
  assert.match(text, /R3,600\.00/);
  assert.match(text, /Delivery to Polokwane depot/);
  assert.match(text, /First National Bank/);
  assert.equal(t.leads.rowObject(2)['Quote link'], url);
  assert.equal(t.leads.rowObject(2).Status, 'Quoted');
});

test('email replies become Gmail drafts, never sent automatically', () => {
  const t = ready();
  const draft = t.post({ action: 'create', requirements: REQUIREMENTS });
  t.post({ action: 'submit', ref: draft.lead.reference, token: draft.editToken, contact: CONTACT });
  const sentBefore = t.sent.length;
  const record = t.gas.rowObject_(t.leads.getRange(2, 1, 1, 31).getValues()[0]);
  t.gas.draftReplyForRecord_(record, 1);
  assert.equal(t.drafts.length, 1);
  assert.equal(t.drafts[0].to, 'thandi@example.co.za');
  assert.match(t.drafts[0].subject, new RegExp(draft.lead.reference));
  assert.match(t.drafts[0].body, /^Dear Thandi Mokoena/);
  assert.doesNotMatch(t.drafts[0].body, /\{\{/);
  assert.equal(t.sent.length, sentBefore);
  assert.equal(t.gas.EMAIL_TEMPLATES.length, 7);
});

test('Vercel config: the page may call Apps Script, and server files are not deployed', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const headers = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /connect-src 'self' https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'(?! 'unsafe)/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  const ignored = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const entry of ['server/', 'tests/', 'data/', 'docs/', 'apps-script/', 'dist/']) assert.ok(ignored.includes(entry), entry);
});
