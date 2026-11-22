'use strict';

/*
 * Future integration points: Website → Backend → Google Apps Script → Google Sheets lead register
 * → business email / WhatsApp follow-up.
 *
 * Nothing here is live until the business supplies credentials through environment variables.
 * Without them every channel reports "not configured" and the lead is only stored by this server.
 */

const crypto = require('node:crypto');
const { STATUS_LABELS, getLeadType } = require('../../shared/lead-schema');
const { formatRand } = require('../../shared/pricing');

const yesNo = (value) => (value ? 'Yes' : 'No');

/** Official business contact address. Override with the BUSINESS_EMAIL environment variable. */
const DEFAULT_BUSINESS_EMAIL = 'Nextgeneration.ai7.0@gmail.com';

/** One row of the Google Sheets lead register, in the column order agreed with the business. */
function toLeadRegisterRow(lead) {
  const req = lead.requirements || {};
  const contact = lead.contact || {};
  return {
    'Lead ID': lead.id,
    Date: lead.createdAt,
    Name: contact.fullName || '',
    Company: contact.company || '',
    Location: contact.location || '',
    Email: contact.email || '',
    Phone: contact.phone || '',
    Quantity: req.quantity,
    'Unit Price': formatRand(req.unitPriceCents),
    Total: formatRand(req.totalCents),
    'Price Wanted': req.targetUnitPriceCents ? formatRand(req.targetUnitPriceCents) : '',
    'Pack Price Wanted': req.targetPackPriceCents ? formatRand(req.targetPackPriceCents) : '',
    'Estimated Selling Price': req.targetTotalCents ? formatRand(req.targetTotalCents) : '',
    'Stickers/Decals': yesNo(req.packaging),
    Delivery: req.delivery ? 'Deliver' : 'Collect',
    'Delivery Point': req.deliveryPoint || '',
    'Lead Type': getLeadType(req.leadType)?.registerLabel || '',
    Status: STATUS_LABELS[lead.status] || lead.status,
  };
}

function describeRequirements(lead) {
  const req = lead.requirements;
  return [
    `Quantity: ${req.quantity.toLocaleString('en-ZA')} pads (${(req.packs ?? Math.floor(req.quantity / 10)).toLocaleString('en-ZA')} packs of 10)`,
    `Price wanted per pad: ${formatRand(req.targetUnitPriceCents)}`,
    `Price wanted per pack of 10: ${formatRand(req.targetPackPriceCents)}`,
    `Estimated selling price: ${formatRand(req.targetTotalCents)}`,
    `Our indicative price per pad: ${formatRand(req.unitPriceCents)} (total ${formatRand(req.totalCents)})`,
    `Stickers/decals on packs: ${yesNo(req.packaging)}`,
    `Delivery: ${req.delivery ? `deliver to ${req.deliveryPoint || '(delivery point not given yet)'}` : 'customer will collect'}`,
    `Requirement: ${getLeadType(req.leadType)?.label || ''}`,
  ].join('\n');
}

/** Internal notification for the sales team (sent once an email transport is configured). */
function buildInternalNotification(lead) {
  const c = lead.contact;
  return {
    subject: `New website enquiry ${lead.id}`,
    text: [
      `Lead reference: ${lead.id}`,
      `Submitted: ${lead.submittedAt}`,
      '',
      `Name: ${c.fullName}`,
      `Company: ${c.company || '-'}`,
      `Location: ${c.location}`,
      `Email: ${c.email}`,
      `Phone: ${c.phone || '-'}`,
      `WhatsApp follow-up permitted: ${yesNo(lead.consent?.whatsappFollowUp)}`,
      '',
      describeRequirements(lead),
    ].join('\n'),
  };
}

/** Acknowledgement for the customer. It must not read as an order or booking confirmation. */
function buildCustomerAcknowledgement(lead, businessEmail = DEFAULT_BUSINESS_EMAIL) {
  return {
    subject: `PureLine Hygiene enquiry ${lead.id} received`,
    text: [
      `Dear ${lead.contact.fullName},`,
      '',
      'Thank you for choosing PureLine Hygiene. Your enquiry has been received and will be reviewed by our team.',
      `Your reference number is ${lead.id}.`,
      '',
      'This is not a confirmed order or booking. We will contact you regarding your requirements.',
      `Questions? Reply to this email or write to ${businessEmail}, quoting ${lead.id}.`,
      '',
      describeRequirements(lead),
    ].join('\n'),
  };
}

/** wa.me link with the reference prefilled. Only for the official WhatsApp Business number. */
function buildWhatsAppLink(businessNumber, reference) {
  const digits = String(businessNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  const text = `Hello PureLine Hygiene, my enquiry reference is ${reference}.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function signPayload(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function createNotifier({ env = process.env, logger = console, fetchImpl = globalThis.fetch } = {}) {
  const appsScriptUrl = env.APPS_SCRIPT_WEBHOOK_URL || '';
  const appsScriptSecret = env.APPS_SCRIPT_SHARED_SECRET || '';
  const sheetsEnabled = Boolean(appsScriptUrl && appsScriptSecret);
  const businessEmail = env.BUSINESS_EMAIL || DEFAULT_BUSINESS_EMAIL;

  /**
   * Emails for a submitted enquiry. The Apps Script sends them from the business Google account
   * (MailApp), so no mail-server credentials are kept on this server.
   */
  function emailsFor(event, lead) {
    if (event !== 'lead.submitted' || !lead.contact) return [];
    const internal = buildInternalNotification(lead);
    const ack = buildCustomerAcknowledgement(lead, businessEmail);
    return [
      { to: businessEmail, replyTo: lead.contact.email, subject: internal.subject, text: internal.text },
      { to: lead.contact.email, replyTo: businessEmail, subject: ack.subject, text: ack.text },
    ];
  }

  async function sendToLeadRegister(event, lead) {
    // Apps Script web apps cannot read request headers, so the HMAC signature travels in the body.
    const payload = JSON.stringify({
      event,
      sentAt: new Date().toISOString(),
      row: toLeadRegisterRow(lead),
      emails: emailsFor(event, lead),
    });
    const response = await fetchImpl(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature: signPayload(payload, appsScriptSecret) }),
    });
    if (!response.ok) throw new Error(`Lead register responded with HTTP ${response.status}`);
  }

  return {
    status() {
      // Email goes out through the Apps Script, so it is live once the lead register is configured.
      return { googleSheets: sheetsEnabled, email: sheetsEnabled, businessEmail, whatsapp: false };
    },

    /** Called after a lead is saved. Failures are logged and never undo the saved lead. */
    async leadEvent(event, lead) {
      if (sheetsEnabled) {
        try {
          await sendToLeadRegister(event, lead);
        } catch (error) {
          logger.error(`[integrations] lead register update failed for ${lead.id}: ${error.message}`);
        }
      }
      // Email: sent by the Apps Script with the lead register update (see emailsFor).
      // WhatsApp: automated messages require an approved WhatsApp Business integration and the
      // customer's whatsappConsent. Until then, staff follow up manually using buildWhatsAppLink.
    },
  };
}

module.exports = {
  toLeadRegisterRow,
  buildInternalNotification,
  buildCustomerAcknowledgement,
  buildWhatsAppLink,
  signPayload,
  createNotifier,
  DEFAULT_BUSINESS_EMAIL,
};
