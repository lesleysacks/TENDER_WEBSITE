/*
 * Lead statuses, qualifying-question options and validation rules.
 * The browser uses these for inline feedback; the server applies the same rules authoritatively.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pricing'));
  else root.PureLineLeadSchema = factory(root.PureLinePricing);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Pricing) {
  'use strict';

  const LEAD_STATUSES = Object.freeze(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST']);

  const STATUS_LABELS = Object.freeze({
    DRAFT: 'Draft',
    SUBMITTED: 'Submitted',
    UNDER_REVIEW: 'Under Review',
    CONTACTED: 'Contacted',
    QUOTED: 'Quoted',
    WON: 'Won',
    LOST: 'Lost',
  });

  const LEAD_TYPES = Object.freeze(
    [
      { value: 'tender-secured', label: 'I have secured a government tender.', registerLabel: 'Tender' },
      { value: 'tender-preparing', label: 'I am preparing a tender submission.', registerLabel: 'Preparation' },
      { value: 'organisation', label: 'I represent an organisation.', registerLabel: 'Organisation' },
      { value: 'bulk', label: 'I am enquiring for bulk supply.', registerLabel: 'Bulk' },
    ].map((type) => Object.freeze(type))
  );

  const MAX_QUANTITY = 1000000;
  const LIMITS = Object.freeze({ fullName: 120, company: 160, location: 120, email: 254, phone: 30 });

  // Trim, drop control characters and collapse internal whitespace.
  function cleanText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function getLeadType(value) {
    return LEAD_TYPES.find((type) => type.value === value) || null;
  }

  function validateRequirements(input) {
    const source = input && typeof input === 'object' ? input : {};
    const errors = {};
    const quantity = Number(source.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      errors.quantity = 'Choose a quantity between 1 and 1,000,000 pads.';
    }
    if (!Pricing.isValidTargetPrice(source.targetUnitPriceCents)) {
      errors.targetUnitPriceCents = `Choose a price between ${Pricing.formatRand(Pricing.TARGET_PRICE.minCents)} and ${Pricing.formatRand(Pricing.TARGET_PRICE.maxCents)} per pad.`;
    }
    if (typeof source.packaging !== 'boolean') errors.packaging = 'Packaging selection is missing.';
    if (typeof source.delivery !== 'boolean') errors.delivery = 'Delivery selection is missing.';
    if (!getLeadType(source.leadType)) errors.leadType = 'Choose the option that best describes your requirement.';

    const ok = Object.keys(errors).length === 0;
    return {
      ok,
      errors,
      value: ok
        ? {
            quantity,
            targetUnitPriceCents: source.targetUnitPriceCents,
            packaging: source.packaging,
            delivery: source.delivery,
            leadType: source.leadType,
          }
        : null,
    };
  }

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const PHONE_PATTERN = /^\+?[\d\s()-]+$/;

  function validateContact(input) {
    const source = input && typeof input === 'object' ? input : {};
    const errors = {};
    const value = {
      fullName: cleanText(source.fullName),
      company: cleanText(source.company),
      location: cleanText(source.location),
      email: cleanText(source.email).toLowerCase(),
      phone: cleanText(source.phone),
      privacyConsent: source.privacyConsent === true,
      whatsappConsent: source.whatsappConsent === true,
    };

    if (value.fullName.length < 2) errors.fullName = 'Enter your full name.';
    else if (value.fullName.length > LIMITS.fullName) errors.fullName = 'Name is too long.';

    if (value.company.length > LIMITS.company) errors.company = 'Company name is too long.';

    if (value.location.length < 2) errors.location = 'Enter your town or city.';
    else if (value.location.length > LIMITS.location) errors.location = 'Location is too long.';

    if (!value.email) errors.email = 'Enter your email address.';
    else if (value.email.length > LIMITS.email || !EMAIL_PATTERN.test(value.email)) {
      errors.email = 'Enter a valid email address, for example name@company.co.za.';
    }

    if (value.phone) {
      const digits = value.phone.replace(/\D/g, '');
      if (value.phone.length > LIMITS.phone || !PHONE_PATTERN.test(value.phone) || digits.length < 9 || digits.length > 15) {
        errors.phone = 'Enter a valid contact number, or leave it blank.';
      }
    }

    if (!value.privacyConsent) errors.privacyConsent = 'Please confirm we may use these details to respond to your enquiry.';
    if (!value.phone) value.whatsappConsent = false;

    const ok = Object.keys(errors).length === 0;
    return { ok, errors, value: ok ? value : null };
  }

  return Object.freeze({
    LEAD_STATUSES,
    STATUS_LABELS,
    LEAD_TYPES,
    LIMITS,
    cleanText,
    getLeadType,
    validateRequirements,
    validateContact,
  });
});
