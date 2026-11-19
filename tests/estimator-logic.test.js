'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../shared/quantity');
const P = require('../shared/pricing');
const V = require('../js/visual-tiers');

test('starting price is R0.30 (thirty cents) per pad', () => {
  assert.equal(P.STARTING_UNIT_PRICE_CENTS, 30);
  assert.equal(P.formatRand(30), 'R0.30');
});

test('estimated total = quantity × unit price, in rand', () => {
  const e = P.estimateSupplyCost(10000);
  assert.equal(e.unitPriceCents, 30);
  assert.equal(e.totalCents, 300000);
  assert.equal(P.formatRand(e.totalCents), 'R3,000.00');
  assert.equal(P.formatRand(P.estimateSupplyCost(1000000).totalCents), 'R300,000.00');
  assert.equal(P.formatRand(P.estimateSupplyCost(1).totalCents), 'R0.30');
  assert.equal(P.formatRand(P.estimateSupplyCost(333).totalCents), 'R99.90');
});

test('loose pads are shown as packs of 10', () => {
  assert.equal(P.PACK_SIZE, 10);
  assert.deepEqual(P.packsOf(10000), { packs: 1000, loose: 0 });
  assert.deepEqual(P.packsOf(25), { packs: 2, loose: 5 });
  assert.deepEqual(P.packsOf(0), { packs: 0, loose: 0 });
});

test('price you want: price per pack of 10 and estimated selling price', () => {
  const e = P.estimateTargetPrice(10000, 35);
  assert.equal(P.formatRand(e.packPriceCents), 'R3.50');
  assert.equal(P.formatRand(e.totalCents), 'R3,500.00');
  assert.equal(P.estimateTargetPrice(0, 35).hasEstimate, false);
  assert.equal(P.estimateTargetPrice(0, 35).packPriceCents, 350, 'pack price still shown at zero quantity');
  assert.equal(P.estimateTargetPrice(1000, 5).hasEstimate, false, 'below the slider minimum');
  assert.equal(P.TARGET_PRICE.defaultCents, 30);
});

test('typed rand prices are parsed to cents', () => {
  assert.equal(P.parseRandInput('0.35'), 35);
  assert.equal(P.parseRandInput('R0,35'), 35);
  assert.equal(P.parseRandInput('1'), 100);
  assert.equal(P.parseRandInput(''), null);
});

test('zero or invalid quantity gives no estimate instead of a misleading price', () => {
  for (const value of [0, -5, 1.5, NaN, 1000001, '']) {
    const e = P.estimateSupplyCost(value);
    assert.equal(e.hasEstimate, false, `quantity ${value}`);
    assert.equal(e.totalCents, null);
  }
});

test('pricing tiers cover 1..1,000,000 without gaps and invent no discounts', () => {
  const tiers = P.PRICING_TIERS;
  assert.equal(tiers[0].minQuantity, 1);
  assert.equal(tiers.at(-1).maxQuantity, Q.MAX_QUANTITY);
  for (let i = 1; i < tiers.length; i += 1) assert.equal(tiers[i].minQuantity, tiers[i - 1].maxQuantity + 1);
  for (const tier of tiers) {
    if (!tier.approved) assert.equal(tier.unitPriceCents, P.STARTING_UNIT_PRICE_CENTS, `${tier.id} is unapproved`);
  }
  assert.equal(P.estimateSupplyCost(9999).tier.id, 'standard');
  assert.equal(P.estimateSupplyCost(10000).tier.id, 'volume');
  assert.equal(P.estimateSupplyCost(500000).tier.id, 'large-scale');
});

test('quantity input parsing and thousands separators', () => {
  assert.equal(Q.parseQuantityInput('12,000'), 12000);
  assert.equal(Q.parseQuantityInput('12 000 pads'), 12000);
  assert.equal(Q.parseQuantityInput(''), null);
  assert.equal(Q.parseQuantityInput('abc'), null);
  assert.equal(Q.parseQuantityInput('99999999999'), Q.MAX_QUANTITY);
  assert.equal(Q.formatQuantity(1000000), '1,000,000');
  assert.equal(Q.formatQuantity(0), '0');
});

test('slider spans 0 to 1,000,000 and stays in sync with typed quantities', () => {
  assert.equal(Q.sliderToQuantity(0), 0);
  assert.equal(Q.sliderToQuantity(Q.SLIDER_STEPS), 1000000);
  let previous = -1;
  for (let p = 0; p <= Q.SLIDER_STEPS; p += 1) {
    const q = Q.sliderToQuantity(p);
    assert.ok(q >= previous, 'monotonic');
    previous = q;
  }
  // The slider is coarser than typed input (which stays exact); it must land close to the typed value.
  for (const q of [0, 500, 10000, 250000, 1000000]) {
    const back = Q.sliderToQuantity(Q.quantityToSlider(q));
    assert.ok(Math.abs(back - q) <= Math.max(50, q * 0.03), `round-trip ${q} -> ${back}`);
  }
  assert.equal(Q.sliderToQuantity(Q.quantityToSlider(10000)), 10000);
});

test('+/- controls step to round numbers and respect bounds', () => {
  assert.equal(Q.stepQuantity(0, 1), 100);
  assert.equal(Q.stepQuantity(0, -1), 0);
  assert.equal(Q.stepQuantity(1000, -1), 900);
  assert.equal(Q.stepQuantity(10000, 1), 11000);
  assert.equal(Q.stepQuantity(12345, 1), 13000);
  assert.equal(Q.stepQuantity(12345, -1), 12000);
  assert.equal(Q.stepQuantity(1000000, 1), 1000000);
});

test('visual tiers match the agreed quantity bands', () => {
  const expectations = [
    [0, 'individual'], [999, 'individual'], [1000, 'small-packs'], [9999, 'small-packs'],
    [10000, 'multiple-packs'], [49999, 'multiple-packs'], [50000, 'bulk-packaging'],
    [199999, 'bulk-packaging'], [200000, 'pallet'], [499999, 'pallet'],
    [500000, 'large-scale'], [1000000, 'large-scale'],
  ];
  for (const [q, id] of expectations) assert.equal(V.getVisualTier(q).id, id, `quantity ${q}`);
  assert.equal(V.tierProgress(0), 0);
  assert.equal(V.tierProgress(1000000), 1);
});
