'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../shared/lead-schema');
const ids = require('../server/lead-id');
const { FileLeadStore } = require('../server/lead-store');
const { toLeadRegisterRow, buildCustomerAcknowledgement, buildWhatsAppLink, signPayload } = require('../server/integrations');

test('lead references look like PLH-8F3A92C7 and are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i += 1) {
    const ref = ids.createLeadReference();
    assert.match(ref, ids.REFERENCE_PATTERN);
    seen.add(ref);
  }
  assert.ok(seen.size >= 19990, 'collisions should be vanishingly rare');
});

test('reference generation retries on collision and fails loudly if it cannot', () => {
  const sequence = [Buffer.from('aaaaaaaa', 'hex'), Buffer.from('bbbbbbbb', 'hex')];
  const ref = ids.createUniqueLeadReference((r) => r === 'PLH-AAAAAAAA', { randomBytes: () => sequence.shift() });
  assert.equal(ref, 'PLH-BBBBBBBB');
  assert.throws(() => ids.createUniqueLeadReference(() => true, { attempts: 3 }));
});

test('edit tokens are random, stored only as hashes and compared safely', () => {
  const token = ids.createEditToken();
  assert.ok(token.length >= 43);
  assert.notEqual(token, ids.createEditToken());
  const hash = ids.hashToken(token);
  assert.ok(ids.tokenMatches(token, hash));
  assert.ok(!ids.tokenMatches(`${token}x`, hash));
  assert.ok(!ids.tokenMatches('', hash));
  assert.ok(!ids.tokenMatches(undefined, hash));
});

test('requirement validation', () => {
  const good = { quantity: 5000, targetUnitPriceCents: 30, packaging: true, delivery: false, leadType: 'bulk' };
  assert.ok(S.validateRequirements({ ...good, targetUnitPriceCents: 5 }).errors.targetUnitPriceCents);
  assert.ok(S.validateRequirements({ ...good, targetUnitPriceCents: 301 }).errors.targetUnitPriceCents);
  assert.ok(S.validateRequirements({ ...good, targetUnitPriceCents: 0.355 }).errors.targetUnitPriceCents);
  assert.ok(S.validateRequirements({ ...good, targetUnitPriceCents: undefined }).errors.targetUnitPriceCents);
  assert.ok(S.validateRequirements(good).ok);
  assert.ok(S.validateRequirements({ ...good, quantity: 0 }).errors.quantity);
  assert.ok(S.validateRequirements({ ...good, quantity: 1000001 }).errors.quantity);
  assert.ok(S.validateRequirements({ ...good, quantity: 10.5 }).errors.quantity);
  assert.ok(S.validateRequirements({ ...good, leadType: 'other' }).errors.leadType);
  assert.ok(S.validateRequirements({ ...good, packaging: 'yes' }).errors.packaging);
  assert.equal(S.validateRequirements(null).ok, false);
});

test('contact validation: email required, phone recommended but optional, consent required', () => {
  const base = { fullName: 'Thandi Mokoena', location: 'Polokwane', email: 'Thandi@Example.co.za', privacyConsent: true };
  const ok = S.validateContact(base);
  assert.ok(ok.ok);
  assert.equal(ok.value.email, 'thandi@example.co.za');
  assert.equal(ok.value.phone, '');
  assert.equal(ok.value.whatsappConsent, false);

  assert.ok(S.validateContact({ ...base, email: 'not-an-email' }).errors.email);
  assert.ok(S.validateContact({ ...base, fullName: ' ' }).errors.fullName);
  assert.ok(S.validateContact({ ...base, location: '' }).errors.location);
  assert.ok(S.validateContact({ ...base, phone: '12' }).errors.phone);
  assert.ok(S.validateContact({ ...base, phone: '+27 82 123 4567' }).ok);
  assert.ok(S.validateContact({ ...base, privacyConsent: false }).errors.privacyConsent);
  assert.equal(S.validateContact({ ...base, fullName: 'A\u0000B  C' }).value.fullName, 'A B C');
});

test('file store persists atomically and reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-store-'));
  const file = path.join(dir, 'leads.json');
  const store = await new FileLeadStore(file).init();
  await store.insert({ id: 'PLH-00000001', status: 'DRAFT', updatedAt: new Date().toISOString(), history: [] });
  await Promise.all([
    store.update('PLH-00000001', (lead) => { lead.a = 1; }),
    store.update('PLH-00000001', (lead) => { lead.b = 2; }),
  ]);
  const reopened = await new FileLeadStore(file).init();
  assert.deepEqual({ a: reopened.get('PLH-00000001').a, b: reopened.get('PLH-00000001').b }, { a: 1, b: 2 });
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  await assert.rejects(store.insert({ id: 'PLH-00000001' }));
});

test('expired drafts are purged; submitted leads are kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plh-purge-'));
  const store = await new FileLeadStore(path.join(dir, 'leads.json')).init();
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  await store.insert({ id: 'PLH-0000000A', status: 'DRAFT', updatedAt: old });
  await store.insert({ id: 'PLH-0000000B', status: 'SUBMITTED', updatedAt: old });
  await store.insert({ id: 'PLH-0000000C', status: 'DRAFT', updatedAt: new Date().toISOString() });
  assert.equal(await store.purgeDrafts(30 * 864e5), 1);
  assert.deepEqual(store.list().map((l) => l.id).sort(), ['PLH-0000000B', 'PLH-0000000C']);
});

test('lead register row matches the Google Sheets columns', () => {
  const lead = {
    id: 'PLH-8F3A92C7', createdAt: '2026-11-19T08:00:00.000Z', status: 'SUBMITTED',
    requirements: { quantity: 20000, packs: 2000, unitPriceCents: 30, totalCents: 600000, targetUnitPriceCents: 25, targetPackPriceCents: 250, targetTotalCents: 500000, packaging: true, delivery: false, leadType: 'tender-secured' },
    contact: { fullName: 'A Buyer', company: 'Org', location: 'Durban', email: 'a@b.co.za', phone: '' },
  };
  const row = toLeadRegisterRow(lead);
  assert.deepEqual(Object.keys(row), ['Lead ID', 'Date', 'Name', 'Company', 'Location', 'Email', 'Phone', 'Quantity', 'Unit Price', 'Total', 'Price Wanted', 'Pack Price Wanted', 'Estimated Selling Price', 'Packaging', 'Delivery', 'Lead Type', 'Status']);
  assert.equal(row['Price Wanted'], 'R0.25');
  assert.equal(row['Pack Price Wanted'], 'R2.50');
  assert.equal(row['Estimated Selling Price'], 'R5,000.00');
  assert.equal(row['Unit Price'], 'R0.30');
  assert.equal(row.Total, 'R6,000.00');
  assert.equal(row['Lead Type'], 'Tender');
  assert.equal(row.Status, 'Submitted');
  assert.match(buildCustomerAcknowledgement(lead).text, /not a confirmed order or booking/);
});

test('WhatsApp links only exist for a configured number and carry the reference', () => {
  assert.equal(buildWhatsAppLink('', 'PLH-1'), null);
  assert.match(buildWhatsAppLink('+27 11 000 0000', 'PLH-8F3A92C7'), /^https:\/\/wa\.me\/27110000000\?text=.*PLH-8F3A92C7/);
  assert.equal(signPayload('x', 'secret').length, 64);
});
