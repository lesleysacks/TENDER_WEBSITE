/*
 * Quantity estimator, supply visualiser and cost estimator. One quantity state drives the slider,
 * the typed input, the +/- controls, the visualiser and the cost estimator.
 * Exposes window.PureLineEstimator for the lead funnel.
 */
(function () {
  'use strict';

  const Q = window.PureLineQuantity;
  const P = window.PureLinePricing;
  const V = window.PureLineVisualTiers;
  const art = window.PureLineIllustrations;
  const config = window.PURELINE_CONFIG || {};
  const photos = config.photography || {};

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  const els = {
    range: $('[data-qty-range]'),
    input: $('[data-qty-input]'),
    steps: $$('[data-qty-step]'),
    product: $('[data-visual-product]'),
    tierStage: $('[data-visual-tier]'),
    tierLabel: $('[data-visual-tier-label]'),
    tierRange: $('[data-visual-tier-range]'),
    galleryToggle: $('[data-gallery-toggle]'),
    gallery: $('[data-gallery]'),
    qtyPacks: $('[data-qty-packs]'),
    qtyLoose: $('[data-qty-loose]'),
    priceInput: $('[data-price-input]'),
    priceRange: $('[data-price-range]'),
    priceSteps: $$('[data-price-step]'),
    priceMin: $('[data-price-min]'),
    priceMax: $('[data-price-max]'),
    pricePack: $('[data-price-pack]'),
    costQuantity: $('[data-cost-quantity]'),
    costPacks: $('[data-cost-packs]'),
    costUnit: $('[data-cost-unit]'),
    costTotal: $('[data-cost-total]'),
    costTier: $('[data-cost-tier]'),
    costCompare: $('[data-cost-compare]'),
    costTierNote: $('[data-cost-tier-note]'),
    costEmpty: $('[data-cost-empty]'),
    packaging: $('[data-req="packaging"]'),
    delivery: $('[data-req="delivery"]'),
  };

  if (!els.range || !els.input) return;

  const PRICE = P.TARGET_PRICE;
  const state = { quantity: 10000, targetCents: PRICE.defaultCents, packaging: false, delivery: false };

  const centsText = (cents) => (cents / 100).toFixed(2); // 30 -> "0.30" (input shows the R prefix)
  const packsText = (quantity) => {
    const { packs, loose } = P.packsOf(quantity);
    return { packs: Q.formatQuantity(packs), loose };
  };
  const listeners = new Set();
  let currentTierId = null;

  const tierImage = (tier) => {
    const src = photos.tiers && photos.tiers[tier.id];
    return src
      ? `<img src="${src}" alt="${tier.label} — supply volume" loading="lazy" decoding="async" />`
      : art.tierIllustration(tier.id, `Illustration: ${tier.label.toLowerCase()}`);
  };

  // ---------- Rendering ----------

  function renderQuantityControls(source) {
    const formatted = Q.formatQuantity(state.quantity);
    if (source !== 'range') els.range.value = String(Q.quantityToSlider(state.quantity));
    els.range.setAttribute('aria-valuetext', `${formatted} pads`);
    if (source !== 'input') els.input.value = formatted;
    els.steps.forEach((button) => {
      const direction = Number(button.dataset.qtyStep);
      button.disabled = direction < 0 ? state.quantity <= Q.MIN_QUANTITY : state.quantity >= Q.MAX_QUANTITY;
    });
    const { packs, loose } = packsText(state.quantity);
    els.qtyPacks.textContent = packs;
    els.qtyLoose.textContent = loose ? `+ ${loose} loose pad${loose === 1 ? '' : 's'}` : 'packs';
  }

  function renderPriceControls(source) {
    if (source !== 'range') els.priceRange.value = String(state.targetCents);
    els.priceRange.setAttribute('aria-valuetext', `${P.formatRand(state.targetCents)} per pad`);
    if (source !== 'input') els.priceInput.value = centsText(state.targetCents);
    els.pricePack.textContent = P.formatRand(state.targetCents * P.PACK_SIZE);
    els.priceSteps.forEach((button) => {
      const direction = Number(button.dataset.priceStep);
      button.disabled = direction < 0 ? state.targetCents <= PRICE.minCents : state.targetCents >= PRICE.maxCents;
    });
  }

  function renderVisualiser() {
    const tier = V.getVisualTier(state.quantity);
    els.tierStage.style.setProperty('--tier-progress', V.tierProgress(state.quantity).toFixed(3));
    if (tier.id !== currentTierId) {
      currentTierId = tier.id;
      els.tierStage.dataset.tier = tier.id;
      els.tierStage.innerHTML = tierImage(tier);
      els.tierStage.classList.remove('is-entering');
      void els.tierStage.offsetWidth; // restart the entrance transition
      els.tierStage.classList.add('is-entering');
      els.tierLabel.textContent = tier.label;
      els.tierRange.textContent = `${tier.range} pads`;
      $$('[data-gallery-tier]', els.gallery).forEach((item) => {
        if (item.dataset.galleryTier === tier.id) item.setAttribute('aria-current', 'true');
        else item.removeAttribute('aria-current');
      });
    }
  }

  function renderCost() {
    const ours = P.estimateSupplyCost(state.quantity);
    const wanted = P.estimateTargetPrice(state.quantity, state.targetCents);
    const { packs, loose } = packsText(state.quantity);

    els.costQuantity.textContent = `${Q.formatQuantity(state.quantity)} pads`;
    els.costPacks.textContent = loose ? `${packs} + ${loose} loose` : packs;
    els.costEmpty.hidden = wanted.hasEstimate;
    els.costTotal.textContent = wanted.hasEstimate ? P.formatRand(wanted.totalCents) : '—';

    // Our own indicative price, shown for reference next to the customer's chosen price.
    els.costUnit.textContent = P.formatRand(ours.hasEstimate ? ours.unitPriceCents : P.STARTING_UNIT_PRICE_CENTS);
    els.costTier.textContent = ours.hasEstimate ? ours.tier.label : 'tier set by quantity';
    els.costCompare.textContent =
      ours.hasEstimate && state.targetCents < ours.unitPriceCents
        ? 'Your price is below our current price; we will confirm what is possible in your quotation.'
        : '';
    els.costTierNote.textContent =
      ours.hasEstimate && !ours.tier.approved ? 'Bulk tier pricing is awaiting approval.' : '';
  }

  function setTargetPrice(cents, source) {
    const next = Math.min(PRICE.maxCents, Math.max(PRICE.minCents, Math.round(Number(cents) || PRICE.defaultCents)));
    const changed = next !== state.targetCents;
    state.targetCents = next;
    renderPriceControls(source);
    renderCost();
    if (changed) emit();
  }

  function emit() {
    const snapshot = api.getRequirements();
    listeners.forEach((listener) => listener(snapshot));
  }

  function setQuantity(value, source) {
    const next = Q.normaliseQuantity(value);
    const changed = next !== state.quantity;
    state.quantity = next;
    renderQuantityControls(source);
    renderVisualiser();
    renderCost();
    if (changed) emit();
  }

  // ---------- Gallery ----------

  function buildGallery() {
    els.gallery.innerHTML = V.VISUAL_TIERS.map(
      (tier) => `
        <li>
          <button class="gallery-item" type="button" data-gallery-tier="${tier.id}">
            <span class="gallery-art">${tierImage(tier)}</span>
            <span class="gallery-label">${tier.label}</span>
            <span class="gallery-range">${tier.range} pads</span>
          </button>
        </li>`
    ).join('');

    els.gallery.addEventListener('click', (event) => {
      const button = event.target.closest('[data-gallery-tier]');
      if (!button) return;
      const tier = V.VISUAL_TIERS.find((t) => t.id === button.dataset.galleryTier);
      setQuantity(tier.min === 0 ? 500 : tier.min);
    });
  }

  function setGalleryOpen(open) {
    els.galleryToggle.setAttribute('aria-expanded', String(open));
    els.galleryToggle.querySelector('[data-gallery-toggle-text]').textContent = open
      ? 'Hide supply gallery'
      : 'View supply gallery';
    els.gallery.closest('[data-gallery-region]').hidden = !open;
  }

  // ---------- Events ----------

  els.range.addEventListener('input', () => setQuantity(Q.sliderToQuantity(els.range.value), 'range'));

  els.input.addEventListener('input', () => {
    const parsed = Q.parseQuantityInput(els.input.value);
    setQuantity(parsed === null ? 0 : parsed, 'input');
  });
  els.input.addEventListener('blur', () => {
    els.input.value = Q.formatQuantity(state.quantity);
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setQuantity(Q.stepQuantity(state.quantity, event.key === 'ArrowUp' ? 1 : -1));
    }
  });

  els.steps.forEach((button) =>
    button.addEventListener('click', () => setQuantity(Q.stepQuantity(state.quantity, Number(button.dataset.qtyStep))))
  );

  els.priceRange.addEventListener('input', () => setTargetPrice(Number(els.priceRange.value), 'range'));
  els.priceInput.addEventListener('input', () => {
    const cents = P.parseRandInput(els.priceInput.value);
    if (cents !== null && P.isValidTargetPrice(cents)) setTargetPrice(cents, 'input');
  });
  els.priceInput.addEventListener('blur', () => {
    const cents = P.parseRandInput(els.priceInput.value);
    setTargetPrice(cents === null ? state.targetCents : cents);
  });
  els.priceInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setTargetPrice(state.targetCents + (event.key === 'ArrowUp' ? PRICE.stepCents : -PRICE.stepCents));
    }
  });
  els.priceSteps.forEach((button) =>
    button.addEventListener('click', () => setTargetPrice(state.targetCents + Number(button.dataset.priceStep) * PRICE.stepCents))
  );

  [els.packaging, els.delivery].forEach((checkbox) =>
    checkbox.addEventListener('change', () => {
      state.packaging = els.packaging.checked;
      state.delivery = els.delivery.checked;
      emit();
    })
  );

  els.galleryToggle.addEventListener('click', () =>
    setGalleryOpen(els.galleryToggle.getAttribute('aria-expanded') !== 'true')
  );

  // ---------- Public API ----------

  const api = Object.freeze({
    getRequirements: () => ({
      quantity: state.quantity,
      targetUnitPriceCents: state.targetCents,
      packaging: state.packaging,
      delivery: state.delivery,
    }),
    setRequirements(requirements) {
      state.packaging = Boolean(requirements.packaging);
      state.delivery = Boolean(requirements.delivery);
      els.packaging.checked = state.packaging;
      els.delivery.checked = state.delivery;
      if (P.isValidTargetPrice(requirements.targetUnitPriceCents)) state.targetCents = requirements.targetUnitPriceCents;
      renderPriceControls();
      setQuantity(requirements.quantity);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    focusQuantity() {
      els.input.focus();
    },
  });
  window.PureLineEstimator = api;

  // ---------- Initial render ----------

  els.product.innerHTML = photos.product
    ? `<img src="${photos.product}" alt="PureLine Hygiene sanitary pad" loading="lazy" decoding="async" />`
    : art.productIllustration();
  buildGallery();
  setGalleryOpen(false);
  els.packaging.checked = state.packaging;
  els.delivery.checked = state.delivery;
  Object.assign(els.priceRange, { min: PRICE.minCents, max: PRICE.maxCents, step: PRICE.stepCents });
  els.priceMin.textContent = P.formatRand(PRICE.minCents);
  els.priceMax.textContent = P.formatRand(PRICE.maxCents);
  renderPriceControls();
  setQuantity(state.quantity);
})();
