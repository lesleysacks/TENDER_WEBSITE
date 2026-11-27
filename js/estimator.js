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
    packInput: $('[data-pack-input]'),
    tallyPads: $('[data-tally-pads]'),
    tallyPacks: $('[data-tally-packs]'),
    steps: $$('[data-qty-step]'),
    product: $('[data-visual-product]'),
    tierStage: $('[data-visual-tier]'),
    tierLabel: $('[data-visual-tier-label]'),
    tierRange: $('[data-visual-tier-range]'),
    galleryToggle: $('[data-gallery-toggle]'),
    gallery: $('[data-gallery]'),
    qtyLoose: $('[data-qty-loose]'),
    priceInput: $('[data-price-input]'),
    priceRange: $('[data-price-range]'),
    priceSteps: $$('[data-price-step]'),
    priceMin: $('[data-price-min]'),
    priceMax: $('[data-price-max]'),
    packPriceInput: $('[data-pack-price-input]'),
    costPacks: $('[data-cost-packs]'),
    costBase: $('[data-cost-base]'),
    costPackPrice: $('[data-cost-pack-price]'),
    costTotal: $('[data-cost-total]'),
    costEmpty: $('[data-cost-empty]'),
    packaging: $('[data-req="packaging"]'),
    collect: $('[data-req="collect"]'),
    deliveryPoint: $('[data-req="deliveryPoint"]'),
  };

  if (!els.range || !els.input) return;

  const PRICE = P.TARGET_PRICE;
  // delivery: true unless the customer ticks "I will arrange collection".
  const state = { quantity: 10000, targetCents: PRICE.defaultCents, packaging: false, delivery: true, deliveryPoint: '' };

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
      ? `<img src="${src}" alt="${tier.label} of PureLine Hygiene sanitary pads (supply volume)" loading="lazy" decoding="async" />`
      : art.tierIllustration(tier.id, `Illustration: ${tier.label.toLowerCase()}`);
  };

  // ---------- Rendering ----------

  function renderQuantityControls(source) {
    const formatted = Q.formatQuantity(state.quantity);
    if (source !== 'range') els.range.value = String(Q.quantityToSlider(state.quantity));
    els.range.setAttribute('aria-valuetext', `${packsText(state.quantity).packs} packs (${formatted} pads)`);
    if (source !== 'input') els.input.value = formatted;
    els.steps.forEach((button) => {
      const direction = Number(button.dataset.qtyStep);
      button.disabled = direction < 0 ? state.quantity <= Q.MIN_QUANTITY : state.quantity >= Q.MAX_QUANTITY;
    });
    const { packs, loose } = packsText(state.quantity);
    if (source !== 'packs') els.packInput.value = packs;
    els.qtyLoose.textContent = loose ? `${packs} packs + ${loose} single pad${loose === 1 ? '' : 's'}.` : '';
    els.tallyPads.textContent = formatted;
    els.tallyPacks.textContent = loose ? `${packs} + ${loose}` : packs;
  }

  function renderPriceControls(source) {
    if (source !== 'range') els.priceRange.value = String(state.targetCents);
    els.priceRange.setAttribute('aria-valuetext', `${P.formatRand(state.targetCents * P.PACK_SIZE)} per pack of 10`);
    if (source !== 'input') els.priceInput.value = centsText(state.targetCents);
    if (source !== 'pack') els.packPriceInput.value = centsText(state.targetCents * P.PACK_SIZE);
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
    const wanted = P.estimateTargetPrice(state.quantity, state.targetCents);
    const { packs, loose } = packsText(state.quantity);
    const packsLabel = `${packs} pack${packs === '1' ? '' : 's'}${loose ? ` + ${loose} single pad${loose === 1 ? '' : 's'}` : ''}`;

    // "You asked for 4,050 packs at your required price of R3.50 per pack. This comes to R14,175.00"
    els.costPacks.textContent = packsLabel;
    els.costPackPrice.textContent = P.formatRand(state.targetCents * P.PACK_SIZE);
    els.costEmpty.hidden = wanted.hasEstimate;
    els.costTotal.textContent = wanted.hasEstimate ? P.formatRand(wanted.totalCents) : '—';
    els.costBase.textContent = wanted.hasEstimate ? `${Q.formatQuantity(state.quantity)} pads in total.` : '';
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

  // Packs of 10: typing packs sets the pad quantity to packs × 10.
  els.packInput.addEventListener('input', () => {
    const packs = Q.parseQuantityInput(els.packInput.value);
    setQuantity(packs === null ? 0 : packs * P.PACK_SIZE, 'packs');
  });
  els.packInput.addEventListener('blur', () => {
    els.packInput.value = packsText(state.quantity).packs;
  });
  els.packInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setQuantity(Q.stepQuantity(state.quantity, event.key === 'ArrowUp' ? 1 : -1));
    }
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
  // Price per pack of 10: R3.50 per pack -> R0.35 per pad (rounded to the nearest cent per pad).
  const packCentsToPad = (cents) => Math.round(cents / P.PACK_SIZE);
  els.packPriceInput.addEventListener('input', () => {
    const cents = P.parseRandInput(els.packPriceInput.value);
    if (cents !== null && P.isValidTargetPrice(packCentsToPad(cents))) setTargetPrice(packCentsToPad(cents), 'pack');
  });
  els.packPriceInput.addEventListener('blur', () => {
    const cents = P.parseRandInput(els.packPriceInput.value);
    setTargetPrice(cents === null ? state.targetCents : packCentsToPad(cents));
  });
  els.packPriceInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setTargetPrice(state.targetCents + (event.key === 'ArrowUp' ? PRICE.stepCents : -PRICE.stepCents));
    }
  });
  els.priceSteps.forEach((button) =>
    button.addEventListener('click', () => setTargetPrice(state.targetCents + Number(button.dataset.priceStep) * PRICE.stepCents))
  );

  function renderDelivery() {
    els.deliveryPoint.disabled = !state.delivery;
    els.deliveryPoint.closest('.field').classList.toggle('is-disabled', !state.delivery);
  }

  [els.packaging, els.collect].forEach((checkbox) =>
    checkbox.addEventListener('change', () => {
      state.packaging = els.packaging.checked;
      state.delivery = !els.collect.checked;
      renderDelivery();
      emit();
    })
  );
  els.deliveryPoint.addEventListener('input', () => {
    state.deliveryPoint = els.deliveryPoint.value;
    emit();
  });

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
      deliveryPoint: state.deliveryPoint.replace(/\s+/g, ' ').trim(),
    }),
    setRequirements(requirements) {
      state.packaging = Boolean(requirements.packaging);
      state.delivery = Boolean(requirements.delivery);
      state.deliveryPoint = typeof requirements.deliveryPoint === 'string' ? requirements.deliveryPoint : '';
      els.packaging.checked = state.packaging;
      els.collect.checked = !state.delivery;
      els.deliveryPoint.value = state.deliveryPoint;
      renderDelivery();
      if (P.isValidTargetPrice(requirements.targetUnitPriceCents)) state.targetCents = requirements.targetUnitPriceCents;
      renderPriceControls();
      setQuantity(requirements.quantity);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    focusQuantity() {
      els.packInput.focus();
    },
  });
  window.PureLineEstimator = api;

  // ---------- Initial render ----------

  els.product.innerHTML = photos.product
    ? `<img src="${photos.product}" alt="PureLine Hygiene sanitary pads, individually wrapped, sold in packs of 10" loading="lazy" decoding="async" />`
    : art.productIllustration();
  buildGallery();
  setGalleryOpen(false);
  els.packaging.checked = state.packaging;
  els.collect.checked = !state.delivery;
  els.deliveryPoint.value = state.deliveryPoint;
  renderDelivery();
  Object.assign(els.priceRange, { min: PRICE.minCents, max: PRICE.maxCents, step: PRICE.stepCents });
  // The slider moves in 1c per pad = 10c per pack; its scale is shown per pack.
  els.priceMin.textContent = `${P.formatRand(PRICE.minCents * P.PACK_SIZE)} / pack`;
  els.priceMax.textContent = `${P.formatRand(PRICE.maxCents * P.PACK_SIZE)} / pack`;
  renderPriceControls();
  setQuantity(state.quantity);
})();
