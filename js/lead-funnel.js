/*
 * Two-stage lead capture.
 *   Stage 1 (50%): requirements + qualifying answer are saved on the server as a DRAFT.
 *   Stage 2 (100%): contact details are attached and the enquiry is SUBMITTED.
 * Progress only reaches 100% after the server accepts the submission.
 */
(function () {
  'use strict';

  const estimator = window.PureLineEstimator;
  const P = window.PureLinePricing;
  const Q = window.PureLineQuantity;
  const S = window.PureLineLeadSchema;
  const config = window.PURELINE_CONFIG || {};
  const API = config.apiBase || '/api';
  // When set, enquiries go straight to the Google Apps Script web app instead of the Node server.
  const APPS_SCRIPT = config.leadsEndpoint || '';
  const SESSION_KEY = 'pureline-enquiry';

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  const els = {
    progress: $('[data-progress]'),
    progressBar: $('[data-progress-bar]'),
    progressText: $('[data-progress-text]'),
    progressSteps: $$('[data-progress-step]'),
    stage1: $('[data-stage1]'),
    leadTypes: $$('input[name="leadType"]'),
    stage1Error: $('[data-stage1-error]'),
    stage1Success: $('[data-stage1-success]'),
    turnstileBox: $('[data-turnstile]'),
    saveDraft: $('[data-save-draft]'),
    stage2: $('[data-stage2]'),
    stage2Heading: $('[data-stage2] h3'),
    summary: (key) => $(`[data-summary="${key}"]`),
    syncStatus: $('[data-sync-status]'),
    editRequirements: $('[data-edit-requirements]'),
    form: $('[data-contact-form]'),
    formStatus: $('[data-form-status]'),
    submit: $('[data-submit-enquiry]'),
    confirmation: $('[data-confirmation]'),
    confirmationReference: $('[data-confirmation-reference]'),
    whatsapp: $('[data-whatsapp-link]'),
    newEnquiry: $('[data-new-enquiry]'),
  };

  if (!estimator || !els.stage1) return;

  let session = readSession(); // { reference, token }
  let stage = 'start'; // 'start' | 'draft' | 'submitted'
  let syncTimer = null;
  let syncPromise = null;
  let pendingSync = false;
  let draftIdempotencyKey = null;

  // Cloudflare Turnstile (optional bot check). Only loaded when the server reports a site key.
  const turnstile = { enabled: false, widget: null, token: '' };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(script);
    });
  }

  async function initTurnstile() {
    try {
      const { turnstileSiteKey } = await api('GET', '/config');
      if (!turnstileSiteKey) return;
      turnstile.enabled = true;
      await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      els.turnstileBox.hidden = false;
      turnstile.widget = window.turnstile.render(els.turnstileBox, {
        sitekey: turnstileSiteKey,
        callback: (token) => { turnstile.token = token; },
        'expired-callback': () => { turnstile.token = ''; },
        'error-callback': () => { turnstile.token = ''; },
      });
    } catch {
      /* If the check cannot load, the server still refuses unverified submissions. */
    }
  }

  function resetTurnstile() {
    if (!turnstile.enabled) return;
    turnstile.token = '';
    try { window.turnstile?.reset(turnstile.widget); } catch { /* widget not ready */ }
  }

  // ---------- Session storage (per tab; failures are harmless) ----------

  function readSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      return value && value.reference && value.token ? value : null;
    } catch {
      return null;
    }
  }
  function writeSession(value) {
    session = value;
    try {
      if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable: the draft still lives for this page view */
    }
  }

  const randomKey = () =>
    window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // ---------- API ----------

  /**
   * Google Apps Script cannot answer CORS preflight requests or read custom headers, so every call
   * is a "simple" text/plain POST carrying an action, the reference and the edit token. Apps Script
   * always replies HTTP 200; the real status is in the JSON body.
   */
  function appsScriptRequest(method, path, body) {
    const [, reference, submit] = path.match(/^\/leads\/([^/]+)(\/submit)?$/) || [];
    let action;
    if (path === '/config') action = 'config';
    else if (path === '/leads' && method === 'POST') action = 'create';
    else if (submit) action = 'submit';
    else if (method === 'PATCH') action = 'update';
    else action = 'get';
    const payload = { action, ...(body || {}) };
    // The backend rejects drafts saved within 3 seconds of the page opening (a bot signal).
    if (action === 'create') payload.elapsedMs = Math.round(performance.now());
    if (reference) payload.ref = reference;
    if (session && reference) payload.token = session.token;
    return fetch(APPS_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      const status = response.ok && data && typeof data.status === 'number' ? data.status : response.ok ? 200 : response.status;
      return { ok: status < 400, status, data };
    });
  }

  /** Real people never hit the backend's "too fast" checks; this pause makes sure of it. */
  const MIN_MS = 3200;
  const waitUntil = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  let draftCreatedAt = 0;

  async function api(method, path, body) {
    if (APPS_SCRIPT) {
      if (method === 'POST' && path === '/leads') await waitUntil(MIN_MS - performance.now());
      if (/\/submit$/.test(path) && draftCreatedAt) await waitUntil(draftCreatedAt + MIN_MS - Date.now());
      let result;
      try {
        result = await appsScriptRequest(method, path, body);
      } catch (error) {
        // Usually the web app is not deployed with "Who has access: Anyone", so Google answers with a
        // sign-in page instead of JSON and the browser blocks it.
        console.warn(`[enquiry] Could not reach the Apps Script web app (${APPS_SCRIPT}). Open that URL in a private window: it should show {"ok":true}. If it asks you to sign in, redeploy with "Who has access: Anyone".`, error);
        throw Object.assign(new Error('We could not reach our server. Your selections are still here — please try again.'), { code: 'network' });
      }
      if (!result.ok) {
        const data = result.data || {};
        throw Object.assign(new Error(data.message || 'Something went wrong. Please try again.'), {
          code: data.error || 'http',
          status: result.status,
          errors: data.errors || {},
        });
      }
      return result.data;
    }

    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(session ? { 'X-Lead-Token': session.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      throw Object.assign(new Error('We could not reach our server. Your selections are still here — please try again.'), { code: 'network' });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.error) {
      // Not our API (e.g. a static file server that cannot save enquiries).
      console.warn(`[enquiry] ${method} ${API}${path} returned HTTP ${response.status} without an API response. Is the site running with "npm start"?`);
      throw Object.assign(new Error('We could not save your enquiry right now. Please try again in a moment.'), {
        code: 'unavailable',
        status: response.status,
        errors: {},
      });
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.message || 'Something went wrong. Please try again.'), {
        code: data.error || 'http',
        status: response.status,
        errors: data.errors || {},
      });
    }
    return data;
  }

  // ---------- Progress ----------

  function setProgress(percent) {
    const labels = { 0: 'Start', 50: 'Supply requirements captured', 100: 'Enquiry submitted' };
    els.progress.style.setProperty('--progress', `${percent}%`);
    els.progressBar.setAttribute('aria-valuenow', String(percent));
    els.progressBar.setAttribute('aria-valuetext', `${percent}% — ${labels[percent]}`);
    els.progressText.textContent = `${percent}% · ${labels[percent]}`;
    els.progressSteps.forEach((step) => {
      const value = Number(step.dataset.progressStep);
      step.classList.toggle('is-complete', value <= percent);
      if (value === percent) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  // ---------- Requirements ----------

  const selectedLeadType = () => els.leadTypes.find((input) => input.checked)?.value || '';

  const currentRequirements = () => ({ ...estimator.getRequirements(), leadType: selectedLeadType() });

  function renderSummary(requirements) {
    // Server values when available (it recalculates everything); local estimate while a change is saving.
    const local = P.estimateTargetPrice(requirements.quantity, requirements.targetUnitPriceCents);
    const { packs } = P.packsOf(requirements.quantity);
    const total = requirements.targetTotalCents ?? local.totalCents;
    els.summary('quantity').textContent = `${Q.formatQuantity(requirements.quantity)} pads (${Q.formatQuantity(packs)} packs of 10)`;
    els.summary('unit').textContent = local.unitPriceCents ? P.formatRand(requirements.targetUnitPriceCents) : '—';
    els.summary('pack').textContent = local.packPriceCents ? P.formatRand(requirements.targetPackPriceCents ?? local.packPriceCents) : '—';
    els.summary('total').textContent = total ? P.formatRand(total) : '—';
    els.summary('packaging').textContent = requirements.packaging ? 'Yes' : 'No — plain white packs';
    els.summary('delivery').textContent = !requirements.delivery
      ? 'Collection'
      : requirements.deliveryPoint
        ? `To ${requirements.deliveryPoint}`
        : 'Required — delivery point to be confirmed';
    els.summary('leadType').textContent = S.getLeadType(requirements.leadType)?.label || '—';
  }

  function showStage1Error(message, focusTarget) {
    els.stage1Error.textContent = message;
    els.stage1Error.hidden = !message;
    if (focusTarget) focusTarget.focus();
  }

  // ---------- Stage 1: save draft ----------

  async function saveDraft() {
    const requirements = currentRequirements();
    const check = S.validateRequirements(requirements);
    if (!check.ok) {
      if (check.errors.quantity) return showStage1Error(check.errors.quantity, $('[data-qty-input]'));
      if (check.errors.leadType) {
        const card = document.getElementById('lead-type');
        if (card) {
          card.classList.remove('needs-answer');
          void card.offsetWidth; // restart the nudge
          card.classList.add('needs-answer');
        }
        return showStage1Error('Choose what best describes you in Step 1 at the top of the page, then save again.', els.leadTypes[0]);
      }
      if (check.errors.deliveryPoint) return showStage1Error(check.errors.deliveryPoint, $('[data-req="deliveryPoint"]'));
      return showStage1Error('Please check your selections.');
    }
    showStage1Error('');

    if (stage === 'draft') {
      await syncNow();
      revealStage2();
      return;
    }

    draftIdempotencyKey = draftIdempotencyKey || randomKey();
    setBusy(els.saveDraft, true, 'Saving your requirements…');
    try {
      const data = await api('POST', '/leads', { requirements: check.value, idempotencyKey: draftIdempotencyKey });
      writeSession({ reference: data.lead.reference, token: data.editToken });
      draftIdempotencyKey = null;
      enterDraftStage(data.lead);
      revealStage2();
    } catch (error) {
      showStage1Error(error.message);
    } finally {
      setBusy(els.saveDraft, false);
    }
  }

  function enterDraftStage(lead) {
    stage = 'draft';
    draftCreatedAt = Date.parse(lead.createdAt) || Date.now();
    setProgress(50);
    renderSummary(lead.requirements);
    setSyncStatus('saved');
    els.saveDraft.querySelector('[data-label]').textContent = 'Continue to contact details';
    els.stage1Success.hidden = false;
    els.stage2.hidden = false;
  }

  function revealStage2() {
    els.stage2.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    els.stage2Heading.focus({ preventScroll: true });
  }

  // ---------- Keep the draft in sync when requirements change ----------

  function setSyncStatus(status, message) {
    const text = {
      saving: 'Saving your changes…',
      saved: `Draft saved · Reference ${session ? session.reference : ''}`,
      error: message || 'Your latest changes are not saved yet.',
    }[status];
    els.syncStatus.textContent = text;
    els.syncStatus.dataset.status = status;
  }

  function scheduleSync() {
    if (stage !== 'draft') return;
    const requirements = currentRequirements();
    if (!S.validateRequirements(requirements).ok) {
      setSyncStatus('error', 'Choose a quantity of at least 1 pad to keep your draft up to date.');
      pendingSync = true;
      clearTimeout(syncTimer);
      return;
    }
    renderSummary(requirements);
    setSyncStatus('saving');
    pendingSync = true;
    clearTimeout(syncTimer);
    // Apps Script answers in 1–3 seconds, so wait a little longer before saving each change.
    syncTimer = setTimeout(syncNow, APPS_SCRIPT ? 1500 : 700);
  }

  function syncNow() {
    clearTimeout(syncTimer);
    if (!pendingSync || stage !== 'draft') return syncPromise || Promise.resolve();
    const requirements = currentRequirements();
    const check = S.validateRequirements(requirements);
    if (!check.ok) return Promise.reject(new Error('Choose a quantity of at least 1 pad before submitting.'));

    pendingSync = false;
    syncPromise = api('PATCH', `/leads/${session.reference}`, { requirements: check.value })
      .then((data) => {
        if (!pendingSync) {
          renderSummary(data.lead.requirements);
          setSyncStatus('saved');
        }
      })
      .catch((error) => {
        pendingSync = true;
        if (error.code === 'not_found') resetToStart('We could not find your saved draft. Please save your requirements again.');
        else setSyncStatus('error', error.message);
        throw error;
      })
      .finally(() => {
        syncPromise = null;
      });
    return syncPromise;
  }

  // ---------- Stage 2: submit ----------

  function clearFieldErrors() {
    $$('[data-error-for]', els.form).forEach((el) => {
      el.textContent = '';
      el.hidden = true;
    });
    $$('[aria-invalid]', els.form).forEach((el) => el.removeAttribute('aria-invalid'));
  }

  function showFieldErrors(errors) {
    let first = null;
    Object.entries(errors).forEach(([name, message]) => {
      const field = els.form.elements.namedItem(name);
      const slot = $(`[data-error-for="${name}"]`, els.form);
      if (slot) {
        slot.textContent = message;
        slot.hidden = false;
      }
      if (field) {
        field.setAttribute('aria-invalid', 'true');
        first = first || field;
      }
    });
    first?.focus();
  }

  function readContact() {
    const f = els.form.elements;
    return {
      fullName: f.fullName.value,
      company: f.company.value,
      location: f.location.value,
      email: f.email.value,
      phone: f.phone.value,
      privacyConsent: f.privacyConsent.checked,
      whatsappConsent: f.whatsappConsent.checked,
    };
  }

  async function submitEnquiry(event) {
    event.preventDefault();
    if (stage !== 'draft' || els.submit.disabled) return;
    clearFieldErrors();
    els.formStatus.textContent = '';

    const contact = readContact();
    const check = S.validateContact(contact);
    if (!check.ok) {
      els.formStatus.textContent = 'Please check the highlighted details.';
      showFieldErrors(check.errors);
      return;
    }

    if (turnstile.enabled && !turnstile.token) {
      els.formStatus.textContent = 'Please complete the security check above the Submit button.';
      return;
    }

    setBusy(els.submit, true, 'Submitting your enquiry…');
    try {
      await syncNow();
      const data = await api('POST', `/leads/${session.reference}/submit`, {
        contact,
        website: els.form.elements.website.value,
        turnstileToken: turnstile.token || undefined,
      });
      showConfirmation(data.lead.reference);
    } catch (error) {
      resetTurnstile(); // tokens are single-use
      if (error.code === 'validation') showFieldErrors(error.errors);
      if (error.code !== 'not_found') els.formStatus.textContent = error.message;
    } finally {
      setBusy(els.submit, false);
    }
  }

  function showConfirmation(reference) {
    stage = 'submitted';
    setProgress(100);
    writeSession(null);
    els.stage1.hidden = true;
    els.stage2.hidden = true;
    els.confirmationReference.textContent = reference;
    const number = String(config.whatsappNumber || '').replace(/\D/g, '');
    if (number) {
      const text = encodeURIComponent(`Hello PureLine Hygiene, my enquiry reference is ${reference}.`);
      els.whatsapp.href = `https://wa.me/${number}?text=${text}`;
      els.whatsapp.hidden = false;
    }
    els.confirmation.hidden = false;
    els.confirmation.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    $('h3', els.confirmation).focus({ preventScroll: true });
  }

  function resetToStart(message) {
    writeSession(null);
    stage = 'start';
    pendingSync = false;
    clearTimeout(syncTimer);
    setProgress(0);
    els.stage1.hidden = false;
    els.stage2.hidden = true;
    els.stage1Success.hidden = true;
    els.confirmation.hidden = true;
    resetTurnstile();
    els.saveDraft.querySelector('[data-label]').textContent = 'Save and continue';
    if (message) showStage1Error(message);
  }

  // ---------- Helpers ----------

  function setBusy(button, busy, label) {
    const labelEl = button.querySelector('[data-label]');
    if (busy) {
      button.dataset.idleLabel = labelEl.textContent;
      labelEl.textContent = label;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      return;
    }
    labelEl.textContent =
      button === els.saveDraft && stage === 'draft' ? 'Continue to contact details' : button.dataset.idleLabel || labelEl.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }

  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Wiring ----------

  els.saveDraft.addEventListener('click', () => {
    saveDraft().catch((error) => showStage1Error(error.message));
  });
  els.leadTypes.forEach((input) =>
    input.addEventListener('change', () => {
      showStage1Error('');
      document.getElementById('lead-type')?.classList.remove('needs-answer');
      scheduleSync();
    })
  );
  estimator.subscribe(scheduleSync);
  els.form.addEventListener('submit', submitEnquiry);
  els.editRequirements.addEventListener('click', () => {
    document.getElementById('quantity-step').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    estimator.focusQuantity();
  });
  els.newEnquiry.addEventListener('click', () => {
    els.form.reset();
    resetToStart();
    document.getElementById('quantity-step').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    estimator.focusQuantity();
  });

  // Restore a saved draft (e.g. after a page refresh) so the customer does not lose it.
  async function restore() {
    setProgress(0);
    if (!session) return;
    try {
      const { lead } = await api('GET', `/leads/${session.reference}`);
      if (lead.status !== 'DRAFT') {
        showConfirmation(lead.reference);
        return;
      }
      estimator.setRequirements(lead.requirements);
      els.leadTypes.forEach((input) => {
        input.checked = input.value === lead.requirements.leadType;
      });
      enterDraftStage(lead);
      pendingSync = false;
    } catch (error) {
      if (error.code === 'not_found') writeSession(null);
    }
  }

  restore();
  initTurnstile();
})();
