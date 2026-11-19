/*
 * Supply-volume visual tiers. These describe illustrations only — they are not packaging
 * specifications. Pricing tiers live separately in shared/pricing.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PureLineVisualTiers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VISUAL_TIERS = Object.freeze(
    [
      { id: 'individual', min: 0, max: 999, label: 'Individual pads', range: '0 – 999' },
      { id: 'small-packs', min: 1000, max: 9999, label: 'Small packs', range: '1,000 – 9,999' },
      { id: 'multiple-packs', min: 10000, max: 49999, label: 'Multiple packs', range: '10,000 – 49,999' },
      { id: 'bulk-packaging', min: 50000, max: 199999, label: 'Bulk packaging', range: '50,000 – 199,999' },
      { id: 'pallet', min: 200000, max: 499999, label: 'Pallet quantities', range: '200,000 – 499,999' },
      { id: 'large-scale', min: 500000, max: 1000000, label: 'Large-scale supply', range: '500,000 – 1,000,000' },
    ].map((tier) => Object.freeze(tier))
  );

  function getVisualTier(quantity) {
    const q = Math.max(0, Math.min(1000000, Math.round(Number(quantity) || 0)));
    return VISUAL_TIERS.find((tier) => q >= tier.min && q <= tier.max);
  }

  /** 0..1 position inside the tier, used for gentle CSS scaling as quantity grows. */
  function tierProgress(quantity) {
    const tier = getVisualTier(quantity);
    const q = Math.max(tier.min, Math.min(tier.max, Number(quantity) || 0));
    return (q - tier.min) / (tier.max - tier.min);
  }

  return Object.freeze({ VISUAL_TIERS, getVisualTier, tierProgress });
});
