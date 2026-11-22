'use strict';

/*
 * Integrations for the Node server: Website → this server → Google Apps Script → Google Sheets lead
 * register + business email. (The site can also talk to the Apps Script directly; see apps-script/.)
 * Row layout and email texts live in shared/lead-messages.js so both paths stay identical.
 *
 * Nothing here is live until APPS_SCRIPT_WEBHOOK_URL and APPS_SCRIPT_SHARED_SECRET are set.
 */

const crypto = require('node:crypto');
const {
  DEFAULT_BUSINESS_EMAIL,
  REGISTER_COLUMNS,
  toLeadRegisterRow,
  describeRequirements,
  buildInternalNotification,
  buildCustomerAcknowledgement,
} = require('../../shared/lead-messages');

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
  REGISTER_COLUMNS,
  describeRequirements,
};
