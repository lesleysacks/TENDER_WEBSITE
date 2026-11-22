/*
 * Lead register row and email texts, shared by the Node server (server/integrations) and the
 * Google Apps Script backend (apps-script/Backend.js, bundled by scripts/build-apps-script.js).
 * Keep this file to plain ES2017 (no optional chaining) so it runs unchanged in Apps Script.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./pricing'), require('./lead-schema'));
  } else {
    root.PureLineLeadMessages = factory(root.PureLinePricing, root.PureLineLeadSchema);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Pricing, Schema) {
  'use strict';

  /** Official business contact address. The Node server can override it with BUSINESS_EMAIL. */
  const DEFAULT_BUSINESS_EMAIL = 'Nextgeneration.ai7.0@gmail.com';

  /** Columns of the Leads sheet, in order. Everything the calculator and contact form collect. */
  const REGISTER_COLUMNS = Object.freeze([
    'Lead ID', 'Status', 'Submitted', 'Created',
    'Name', 'Company', 'Town/City', 'Email', 'Phone', 'WhatsApp OK',
    'Lead Type', 'Quantity (pads)', 'Packs of 10', 'Single pads',
    'Price wanted /pad', 'Price wanted /pack', 'Customer total',
    'Our price /pad', 'Our total', 'Pricing tier',
    'Stickers/Decals', 'Delivery', 'Delivery point',
    'Staff notes', 'Quote link',
  ]);

  /** Columns staff fill in. The website never overwrites them once they have a value. */
  const STAFF_COLUMNS = Object.freeze(['Staff notes', 'Quote link']);

  /** Statuses staff move a lead to; the website never overwrites these. */
  const STAFF_STATUS_LABELS = Object.freeze(['Under Review', 'Contacted', 'Quoted', 'Won', 'Lost']);

  const yesNo = (value) => (value ? 'Yes' : 'No');
  const rands = (cents) => (typeof cents === 'number' && isFinite(cents) ? Math.round(cents) / 100 : '');
  const groupDigits = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const leadTypeOf = (value) => Schema.getLeadType(value) || { label: '', registerLabel: '' };
  const tierLabel = (id) => {
    const tier = Pricing.PRICING_TIERS.find((t) => t.id === id);
    return tier ? tier.label : '';
  };

  /**
   * One row of the Leads sheet. Money is in rands as numbers (so the sheet can total it),
   * dates are ISO strings, yes/no fields are text.
   */
  function toLeadRegisterRow(lead) {
    const req = lead.requirements || {};
    const contact = lead.contact || {};
    const consent = lead.consent || {};
    const quantity = Number(req.quantity) || 0;
    return {
      'Lead ID': lead.id,
      Status: Schema.STATUS_LABELS[lead.status] || lead.status || '',
      Submitted: lead.submittedAt || '',
      Created: lead.createdAt || '',
      Name: contact.fullName || '',
      Company: contact.company || '',
      'Town/City': contact.location || '',
      Email: contact.email || '',
      Phone: contact.phone || '',
      'WhatsApp OK': lead.contact ? yesNo(consent.whatsappFollowUp) : '',
      'Lead Type': leadTypeOf(req.leadType).registerLabel,
      'Quantity (pads)': quantity,
      'Packs of 10': req.packs != null ? req.packs : Math.floor(quantity / Pricing.PACK_SIZE),
      'Single pads': quantity % Pricing.PACK_SIZE,
      'Price wanted /pad': rands(req.targetUnitPriceCents),
      'Price wanted /pack': rands(req.targetPackPriceCents),
      'Customer total': rands(req.targetTotalCents),
      'Our price /pad': rands(req.unitPriceCents),
      'Our total': rands(req.totalCents),
      'Pricing tier': tierLabel(req.pricingTier),
      'Stickers/Decals': yesNo(req.packaging),
      Delivery: req.delivery ? 'Deliver' : 'Collect',
      'Delivery point': req.deliveryPoint || '',
      'Staff notes': '',
      'Quote link': '',
    };
  }

  function describeRequirements(lead) {
    const req = lead.requirements;
    const packs = req.packs != null ? req.packs : Math.floor(req.quantity / Pricing.PACK_SIZE);
    return [
      `Quantity: ${groupDigits(req.quantity)} pads (${groupDigits(packs)} packs of 10)`,
      `Price wanted per pad: ${Pricing.formatRand(req.targetUnitPriceCents)}`,
      `Price wanted per pack of 10: ${Pricing.formatRand(req.targetPackPriceCents)}`,
      `Estimated selling price: ${Pricing.formatRand(req.targetTotalCents)}`,
      `Our indicative price per pad: ${Pricing.formatRand(req.unitPriceCents)} (total ${Pricing.formatRand(req.totalCents)})`,
      `Stickers/decals on packs: ${yesNo(req.packaging)}`,
      `Delivery: ${req.delivery ? `deliver to ${req.deliveryPoint || '(delivery point not given yet)'}` : 'customer will collect'}`,
      `Requirement: ${leadTypeOf(req.leadType).label}`,
    ].join('\n');
  }

  /**
   * Internal notification for the sales team. `links` (optional) adds quick links into the lead
   * register: { row: link to this enquiry's row, dashboard: link to the dashboard }.
   */
  function buildInternalNotification(lead, links) {
    const c = lead.contact;
    const quick = links || {};
    return {
      subject: `New website enquiry ${lead.id}`,
      text: [
        `Lead reference: ${lead.id}`,
        `Submitted: ${lead.submittedAt}`,
        ...(quick.row ? ['', `Open this enquiry in the lead register: ${quick.row}`] : []),
        ...(quick.dashboard ? [`Dashboard: ${quick.dashboard}`] : []),
        '',
        `Name: ${c.fullName}`,
        `Company: ${c.company || '-'}`,
        `Location: ${c.location}`,
        `Email: ${c.email}`,
        `Phone: ${c.phone || '-'}`,
        `WhatsApp follow-up permitted: ${yesNo(lead.consent && lead.consent.whatsappFollowUp)}`,
        '',
        describeRequirements(lead),
      ].join('\n'),
    };
  }

  /** Acknowledgement for the customer. It must not read as an order or booking confirmation. */
  function buildCustomerAcknowledgement(lead, businessEmail) {
    const contactAddress = businessEmail || DEFAULT_BUSINESS_EMAIL;
    return {
      subject: `PureLine Hygiene enquiry ${lead.id} received`,
      text: [
        `Dear ${lead.contact.fullName},`,
        '',
        'Thank you for choosing PureLine Hygiene. Your enquiry has been received and will be reviewed by our team.',
        `Your reference number is ${lead.id}.`,
        '',
        'This is not a confirmed order or booking. We will contact you regarding your requirements.',
        `Questions? Reply to this email or write to ${contactAddress}, quoting ${lead.id}.`,
        '',
        describeRequirements(lead),
      ].join('\n'),
    };
  }

  return Object.freeze({
    DEFAULT_BUSINESS_EMAIL,
    REGISTER_COLUMNS,
    STAFF_COLUMNS,
    STAFF_STATUS_LABELS,
    toLeadRegisterRow,
    describeRequirements,
    buildInternalNotification,
    buildCustomerAcknowledgement,
  });
});
