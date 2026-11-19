'use strict';

/*
 * Lead lifecycle: Stage 1 saves a DRAFT (~50%), Stage 2 submits it (100%).
 * The server is authoritative: it validates input, recalculates pricing and generates references.
 */

const crypto = require('node:crypto');
const { estimateSupplyCost, estimateTargetPrice, packsOf, PACK_SIZE } = require('../shared/pricing');
const { validateRequirements, validateContact } = require('../shared/lead-schema');
const { createUniqueLeadReference, createEditToken, hashToken, tokenMatches } = require('./lead-id');

const REPLAY_TTL_MS = 15 * 60 * 1000;

class LeadError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// All amounts are recalculated here from the quantity and chosen price; browser totals are ignored.
function priceRequirements(requirements) {
  const estimate = estimateSupplyCost(requirements.quantity);
  const target = estimateTargetPrice(requirements.quantity, requirements.targetUnitPriceCents);
  return {
    quantity: requirements.quantity,
    packSize: PACK_SIZE,
    packs: packsOf(requirements.quantity).packs,
    // Our indicative pricing (starting price / tier)
    unitPriceCents: estimate.unitPriceCents,
    totalCents: estimate.totalCents,
    pricingTier: estimate.tier.id,
    pricingTierApproved: estimate.tier.approved,
    // The customer's chosen price and resulting estimated selling price
    targetUnitPriceCents: target.unitPriceCents,
    targetPackPriceCents: target.packPriceCents,
    targetTotalCents: target.totalCents,
    packaging: requirements.packaging,
    delivery: requirements.delivery,
    leadType: requirements.leadType,
  };
}

/** What the browser is allowed to see. Contact details and token hashes are never returned. */
function publicView(lead) {
  return {
    reference: lead.id,
    status: lead.status,
    createdAt: lead.createdAt,
    submittedAt: lead.submittedAt,
    requirements: { ...lead.requirements },
  };
}

function createLeadService({ store, notifier, now = () => new Date(), logger = console }) {
  const replays = new Map();

  const timestamp = () => now().toISOString();

  function notify(event, lead) {
    Promise.resolve()
      .then(() => notifier?.leadEvent(event, lead))
      .catch((error) => logger.error(`[leads] notifier failed for ${lead.id}: ${error.message}`));
  }

  function rememberReplay(key, value) {
    const time = Date.now();
    for (const [k, entry] of replays) if (entry.expiresAt <= time) replays.delete(k);
    replays.set(key, { ...value, expiresAt: time + REPLAY_TTL_MS });
  }

  function authorise(reference, token) {
    const lead = store.get(reference);
    // Unknown reference and wrong token look identical, so references cannot be probed.
    if (!lead || !tokenMatches(token, lead.editTokenHash)) {
      throw new LeadError('not_found', 'Enquiry not found.');
    }
    return lead;
  }

  async function createDraft(input, idempotencyKey) {
    const result = validateRequirements(input);
    if (!result.ok) throw new LeadError('validation', 'Please check your supply requirements.', result.errors);

    if (idempotencyKey) {
      const replay = replays.get(idempotencyKey);
      if (replay && replay.expiresAt > Date.now()) {
        const existing = store.get(replay.reference);
        if (existing) return { lead: publicView(existing), token: replay.token, replayed: true };
      }
    }

    const at = timestamp();
    const requirements = priceRequirements(result.value);
    const token = createEditToken();
    const lead = {
      id: createUniqueLeadReference((reference) => store.has(reference)),
      uuid: crypto.randomUUID(),
      status: 'DRAFT',
      source: 'website',
      createdAt: at,
      updatedAt: at,
      submittedAt: null,
      requirements,
      draftSnapshot: { ...requirements, savedAt: at },
      submittedRequirements: null,
      contact: null,
      consent: null,
      editTokenHash: hashToken(token),
      history: [{ at, event: 'DRAFT_SAVED', status: 'DRAFT' }],
    };

    await store.insert(lead);
    if (idempotencyKey) rememberReplay(idempotencyKey, { reference: lead.id, token });
    notify('lead.draft_saved', lead);
    return { lead: publicView(lead), token, replayed: false };
  }

  async function getDraft(reference, token) {
    return publicView(authorise(reference, token));
  }

  async function updateDraft(reference, token, input) {
    authorise(reference, token);
    const result = validateRequirements(input);
    if (!result.ok) throw new LeadError('validation', 'Please check your supply requirements.', result.errors);

    let locked = false;
    const updated = await store.update(reference, (lead) => {
      if (lead.status !== 'DRAFT') {
        locked = true;
        return;
      }
      const at = timestamp();
      lead.requirements = priceRequirements(result.value);
      lead.updatedAt = at;
      lead.history.push({ at, event: 'REQUIREMENTS_UPDATED', status: 'DRAFT' });
    });
    if (locked) throw new LeadError('conflict', 'This enquiry has already been submitted and can no longer be changed.');
    return publicView(updated);
  }

  async function submit(reference, token, contactInput) {
    authorise(reference, token);
    const result = validateContact(contactInput);

    let alreadySubmitted = false;
    let updated;
    if (store.get(reference).status !== 'DRAFT') {
      alreadySubmitted = true;
      updated = store.get(reference);
    } else {
      if (!result.ok) throw new LeadError('validation', 'Please check your contact details.', result.errors);
      // The status check runs inside the synchronous mutator, so two concurrent submissions
      // cannot both move the lead from DRAFT to SUBMITTED.
      updated = await store.update(reference, (lead) => {
        if (lead.status !== 'DRAFT') {
          alreadySubmitted = true;
          return;
        }
        const at = timestamp();
        const { privacyConsent, whatsappConsent, ...contact } = result.value;
        lead.contact = contact;
        lead.consent = { privacyNoticeAcceptedAt: at, whatsappFollowUp: whatsappConsent };
        lead.status = 'SUBMITTED';
        lead.submittedAt = at;
        lead.updatedAt = at;
        lead.submittedRequirements = { ...lead.requirements };
        lead.history.push({ at, event: 'SUBMITTED', status: 'SUBMITTED' });
      });
    }

    if (!alreadySubmitted) notify('lead.submitted', updated);
    return { lead: publicView(updated), alreadySubmitted };
  }

  return { createDraft, getDraft, updateDraft, submit };
}

module.exports = { createLeadService, LeadError, publicView };
