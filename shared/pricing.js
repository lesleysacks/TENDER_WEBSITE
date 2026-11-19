/*
 * PureLine Hygiene pricing configuration — the single source of pricing for the estimator and the server.
 *
 * Only the R0.30 (thirty cents) starting price per pad is confirmed. The bulk tiers below are
 * PLACEHOLDERS awaiting management approval: every tier currently uses the starting price, so no
 * discount is advertised. To approve a tier, set its unitPriceCents and change approved to true.
 * The server recalculates every estimate from this file; prices sent by the browser are ignored.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PureLinePricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STARTING_UNIT_PRICE_CENTS = 30; // R0.30 per pad

  const PRICING_TIERS = Object.freeze(
    [
      { id: 'standard', label: 'Standard supply', minQuantity: 1, maxQuantity: 9999, unitPriceCents: 30, approved: true },
      { id: 'volume', label: 'Volume supply', minQuantity: 10000, maxQuantity: 49999, unitPriceCents: 30, approved: false },
      { id: 'bulk', label: 'Bulk supply', minQuantity: 50000, maxQuantity: 199999, unitPriceCents: 30, approved: false },
      { id: 'pallet', label: 'Pallet supply', minQuantity: 200000, maxQuantity: 499999, unitPriceCents: 30, approved: false },
      { id: 'large-scale', label: 'Large-scale supply', minQuantity: 500000, maxQuantity: 1000000, unitPriceCents: 30, approved: false },
    ].map((tier) => Object.freeze(tier))
  );

  const MAX_PRICED_QUANTITY = PRICING_TIERS[PRICING_TIERS.length - 1].maxQuantity;

  // Pads are counted loose and shown as packs of 10.
  const PACK_SIZE = 10;

  // The "price you want" slider (in cents per pad). Range is a placeholder awaiting management approval.
  const TARGET_PRICE = Object.freeze({ minCents: 10, maxCents: 300, stepCents: 1, defaultCents: STARTING_UNIT_PRICE_CENTS });

  /** 25 pads -> { packs: 2, loose: 5 } */
  function packsOf(quantity) {
    const q = Math.max(0, Math.floor(Number(quantity) || 0));
    return { packs: Math.floor(q / PACK_SIZE), loose: q % PACK_SIZE };
  }

  function isValidTargetPrice(cents) {
    return Number.isInteger(cents) && cents >= TARGET_PRICE.minCents && cents <= TARGET_PRICE.maxCents;
  }

  /**
   * The customer's own price: price per pack of 10 and the estimated selling price
   * (quantity × chosen price per pad). Returns no estimate for zero quantity or an invalid price.
   */
  function estimateTargetPrice(quantity, unitCents) {
    const q = Number(quantity);
    const cents = Number(unitCents);
    const packPriceCents = isValidTargetPrice(cents) ? cents * PACK_SIZE : null;
    const valid = Number.isInteger(q) && q > 0 && q <= MAX_PRICED_QUANTITY && packPriceCents !== null;
    return {
      hasEstimate: valid,
      unitPriceCents: isValidTargetPrice(cents) ? cents : null,
      packPriceCents,
      totalCents: valid ? q * cents : null,
    };
  }

  /** "0.35", "R0,35", "35c" style input -> 35 (cents), or null. */
  function parseRandInput(text) {
    const cleaned = String(text ?? '').replace(/[^\d.,]/g, '').replace(',', '.');
    if (!cleaned) return null;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }

  function getPricingTier(quantity) {
    return PRICING_TIERS.find((tier) => quantity >= tier.minQuantity && quantity <= tier.maxQuantity) || null;
  }

  /**
   * Estimated total = quantity × applicable unit price. Amounts are whole cents to avoid
   * floating-point drift. Zero or invalid quantities return no estimate rather than R0.00.
   */
  function estimateSupplyCost(quantity) {
    const q = Number(quantity);
    if (!Number.isInteger(q) || q <= 0 || q > MAX_PRICED_QUANTITY) {
      return { quantity: Number.isInteger(q) && q > 0 ? q : 0, hasEstimate: false, tier: null, unitPriceCents: null, totalCents: null };
    }
    const tier = getPricingTier(q);
    return {
      quantity: q,
      hasEstimate: true,
      tier: { id: tier.id, label: tier.label, approved: tier.approved },
      unitPriceCents: tier.unitPriceCents,
      totalCents: q * tier.unitPriceCents,
    };
  }

  /** 3000000 cents -> "R30,000.00"; 30 -> "R0.30" */
  function formatRand(cents) {
    const value = Math.round(Number(cents) || 0);
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    const rands = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}R${rands}.${String(abs % 100).padStart(2, '0')}`;
  }

  return Object.freeze({
    STARTING_UNIT_PRICE_CENTS,
    PRICING_TIERS,
    MAX_PRICED_QUANTITY,
    PACK_SIZE,
    TARGET_PRICE,
    getPricingTier,
    estimateSupplyCost,
    packsOf,
    isValidTargetPrice,
    estimateTargetPrice,
    parseRandInput,
    formatRand,
  });
});
