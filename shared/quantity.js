/*
 * Quantity rules shared by the browser estimator and the server.
 * Loaded as a plain <script> in the browser (window.PureLineQuantity) and via require() in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PureLineQuantity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_QUANTITY = 0;
  const MAX_QUANTITY = 1000000;
  const SLIDER_STEPS = 1000;

  const groupDigits = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /** Clamp any value to a whole number of pads between 0 and 1,000,000. Invalid input becomes 0. */
  function normaliseQuantity(value) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return MIN_QUANTITY;
    return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.round(number)));
  }

  /** Parse typed input such as "12,000" or "12 000". Returns null when nothing numeric was typed. */
  function parseQuantityInput(text) {
    const digits = String(text ?? '').replace(/[^\d]/g, '');
    if (!digits) return null;
    return normaliseQuantity(Number(digits.slice(0, 9)));
  }

  /** 1000000 -> "1,000,000" */
  function formatQuantity(value) {
    return groupDigits(String(normaliseQuantity(value)));
  }

  // The slider uses a squared curve so small quantities stay selectable on a 0–1,000,000 range.
  function snap(quantity) {
    if (quantity < 1000) return Math.round(quantity / 10) * 10;
    if (quantity < 10000) return Math.round(quantity / 100) * 100;
    if (quantity < 100000) return Math.round(quantity / 500) * 500;
    return Math.round(quantity / 5000) * 5000;
  }

  function sliderToQuantity(position) {
    const p = Math.min(SLIDER_STEPS, Math.max(0, Number(position) || 0));
    if (p === SLIDER_STEPS) return MAX_QUANTITY;
    return normaliseQuantity(snap(MAX_QUANTITY * (p / SLIDER_STEPS) ** 2));
  }

  function quantityToSlider(quantity) {
    const q = normaliseQuantity(quantity);
    return Math.round(Math.sqrt(q / MAX_QUANTITY) * SLIDER_STEPS);
  }

  function stepFor(quantity) {
    if (quantity < 1000) return 100;
    if (quantity < 50000) return 1000;
    if (quantity < 200000) return 5000;
    return 10000;
  }

  /** Next value for the +/- controls. Steps grow with the quantity and land on round numbers. */
  function stepQuantity(quantity, direction) {
    const q = normaliseQuantity(quantity);
    if (direction > 0) {
      const step = stepFor(q);
      return normaliseQuantity(Math.floor(q / step) * step + step);
    }
    if (q === 0) return 0;
    const step = stepFor(q - 1);
    return normaliseQuantity(Math.ceil(q / step) * step - step);
  }

  return Object.freeze({
    MIN_QUANTITY,
    MAX_QUANTITY,
    SLIDER_STEPS,
    normaliseQuantity,
    parseQuantityInput,
    formatQuantity,
    sliderToQuantity,
    quantityToSlider,
    stepQuantity,
  });
});
