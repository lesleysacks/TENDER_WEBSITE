/*
 * PureLine Hygiene — Google Apps Script backend.
 *
 * The website (on Vercel) posts enquiries straight to this script, deployed as a web app.
 * It keeps every lead in the "Leads" tab of the Google Sheet the script is attached to, emails the
 * team and the customer, and gives staff a "PureLine" menu to create quotations and draft replies.
 *
 * Do not edit dist/apps-script/Code.gs by hand: it is built from this file plus shared/pricing.js,
 * shared/lead-schema.js and shared/lead-messages.js (npm run build:apps-script), so the website,
 * the Node server and this script all use the same pricing and validation rules.
 *
 * Written for the Apps Script V8 runtime: plain ES2017, no optional chaining.
 */

/* global PureLinePricing, PureLineLeadSchema, PureLineLeadMessages, SpreadsheetApp, LockService,
   CacheService, PropertiesService, Utilities, MailApp, GmailApp, DriveApp, DocumentApp, Session,
   ContentService, UrlFetchApp, ScriptApp, Charts, Logger */

var P = PureLinePricing;
var S = PureLineLeadSchema;
var M = PureLineLeadMessages;

var CONFIG = {
  FOLDER_NAME: 'PureLine Hygiene',
  SHEETS: { dashboard: 'Dashboard', leads: 'Leads', settings: 'Settings', help: 'How to use', chartData: 'Chart data' },
  WEBSITE_URL: 'https://pureline-sable.vercel.app',
  MAX_BODY_CHARS: 16 * 1024,
  DRAFT_RETENTION_DAYS: 30,
  IDEMPOTENCY_SECONDS: 15 * 60,
  HOURLY_DRAFT_CAP: 300,
  HOURLY_SUBMIT_CAP: 150,
  HISTORY_LIMIT: 50,
};

// Hidden columns after the visible register columns. They hold what the website needs.
var SYSTEM_COLUMNS = ['_tokenHash', '_updatedAt', '_consent', '_requirements', '_draftSnapshot', '_history'];
var HEADERS = M.REGISTER_COLUMNS.concat(SYSTEM_COLUMNS);
var REFERENCE_PATTERN = /^PLH-[0-9A-F]{8}$/;

var STATUS_CODES = (function () {
  var map = {};
  Object.keys(S.STATUS_LABELS).forEach(function (code) { map[S.STATUS_LABELS[code]] = code; });
  return map;
})();

var ERROR_STATUS = {
  validation: 422, not_found: 404, conflict: 409, invalid_json: 400, payload_too_large: 413,
  rejected: 400, rate_limited: 429, verification_failed: 403, unknown_action: 400, forbidden: 403,
};

function LeadError_(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

// =====================================================================================
// Web app entry points
// =====================================================================================

/** GET /exec: a health check, so you can open the URL in a browser and see it is running. */
function doGet() {
  return json_({ status: 200, ok: true, service: 'PureLine Hygiene enquiries' });
}

/**
 * POST /exec with a text/plain JSON body (text/plain avoids a CORS preflight, which Apps Script
 * cannot answer). Apps Script always replies HTTP 200, so the real status is in the body.
 */
function doPost(e) {
  try {
    var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (raw.length > CONFIG.MAX_BODY_CHARS) throw LeadError_('payload_too_large', 'Request is too large.');
    var body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (parseError) {
      throw LeadError_('invalid_json', 'Request body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw LeadError_('invalid_json', 'Request body is not valid JSON.');
    return json_(Object.assign({ status: 200 }, handleRequest_(body)));
  } catch (error) {
    if (error && error.code && ERROR_STATUS[error.code]) {
      var reply = { status: ERROR_STATUS[error.code], error: error.code, message: error.message };
      if (error.details) reply.errors = error.details;
      return json_(reply);
    }
    console.error(error && error.stack ? error.stack : error);
    return json_({ status: 500, error: 'server_error', message: 'Something went wrong on our side. Please try again.' });
  }
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest_(body) {
  // Rows sent by the optional Node server (signed with SHARED_SECRET) keep working.
  if (typeof body.payload === 'string' && typeof body.signature === 'string') return handleSignedRow_(body);

  var action = body.action;
  if (action === 'config') return { turnstileSiteKey: turnstileSiteKey_() || null };
  if (['create', 'get', 'update', 'submit'].indexOf(action) === -1) throw LeadError_('unknown_action', 'Unknown action.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (action === 'create') return createDraft_(body);
    if (action === 'get') return { lead: publicView_(authorise_(body.ref, body.token).lead) };
    if (action === 'update') return updateDraft_(body);
    return submitEnquiry_(body);
  } finally {
    lock.releaseLock();
  }
}

// =====================================================================================
// Lead lifecycle (mirrors server/lead-service.js)
// =====================================================================================

function priceRequirements_(value) {
  var estimate = P.estimateSupplyCost(value.quantity);
  var target = P.estimateTargetPrice(value.quantity, value.targetUnitPriceCents);
  return {
    quantity: value.quantity,
    packSize: P.PACK_SIZE,
    packs: P.packsOf(value.quantity).packs,
    unitPriceCents: estimate.unitPriceCents,
    totalCents: estimate.totalCents,
    pricingTier: estimate.tier.id,
    pricingTierApproved: estimate.tier.approved,
    targetUnitPriceCents: target.unitPriceCents,
    targetPackPriceCents: target.packPriceCents,
    targetTotalCents: target.totalCents,
    packaging: value.packaging,
    delivery: value.delivery,
    deliveryPoint: value.deliveryPoint || '',
    leadType: value.leadType,
  };
}

/** What the browser may see. Contact details and token hashes never leave the sheet. */
function publicView_(lead) {
  return {
    reference: lead.id,
    status: lead.status,
    createdAt: lead.createdAt,
    submittedAt: lead.submittedAt || null,
    requirements: lead.requirements,
  };
}

function isSpam_(body) {
  return typeof body.website === 'string' && body.website.trim() !== '';
}

function createDraft_(body) {
  if (isSpam_(body)) throw LeadError_('rejected', 'Unable to process this request.');
  var check = S.validateRequirements(body.requirements);
  if (!check.ok) throw LeadError_('validation', 'Please check your supply requirements.', check.errors);

  var cache = CacheService.getScriptCache();
  var key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.slice(0, 64) : '';
  if (key) {
    var replay = parseJson_(cache.get('idem:' + key), null);
    if (replay) {
      var existing = findLead_(replay.reference);
      if (existing) return { lead: publicView_(existing.lead), editToken: replay.token, replayed: true };
    }
  }
  if (!underHourlyCap_('create', CONFIG.HOURLY_DRAFT_CAP)) {
    throw LeadError_('rate_limited', 'Too many requests. Please wait a few minutes and try again.');
  }

  var at = new Date().toISOString();
  var requirements = priceRequirements_(check.value);
  var token = newToken_();
  var lead = {
    id: uniqueReference_(),
    status: 'DRAFT',
    createdAt: at,
    updatedAt: at,
    submittedAt: null,
    requirements: requirements,
    draftSnapshot: Object.assign({}, requirements, { savedAt: at }),
    contact: null,
    consent: null,
    tokenHash: sha256Hex_(token),
    history: [{ at: at, event: 'DRAFT_SAVED', status: 'DRAFT' }],
  };
  writeLead_(null, lead, null);
  if (key) cache.put('idem:' + key, JSON.stringify({ reference: lead.id, token: token }), CONFIG.IDEMPOTENCY_SECONDS);
  return { lead: publicView_(lead), editToken: token };
}

function updateDraft_(body) {
  var found = authorise_(body.ref, body.token);
  var check = S.validateRequirements(body.requirements);
  if (!check.ok) throw LeadError_('validation', 'Please check your supply requirements.', check.errors);
  var lead = found.lead;
  if (lead.status !== 'DRAFT') throw LeadError_('conflict', 'This enquiry has already been submitted and can no longer be changed.');
  var at = new Date().toISOString();
  lead.requirements = priceRequirements_(check.value);
  lead.updatedAt = at;
  pushHistory_(lead, { at: at, event: 'REQUIREMENTS_UPDATED', status: 'DRAFT' });
  writeLead_(found.row, lead, found.values);
  return { lead: publicView_(lead) };
}

function submitEnquiry_(body) {
  var found = authorise_(body.ref, body.token);
  var lead = found.lead;
  // Repeat submissions return the same confirmation and never email twice.
  if (lead.status !== 'DRAFT') return { lead: publicView_(lead), alreadySubmitted: true };

  if (isSpam_(body)) throw LeadError_('rejected', 'Unable to process this request.');
  if (turnstileSiteKey_() && !verifyTurnstile_(body.turnstileToken)) {
    throw LeadError_('verification_failed', 'Please complete the security check and try again.');
  }
  var check = S.validateContact(body.contact);
  if (!check.ok) throw LeadError_('validation', 'Please check your contact details.', check.errors);
  if (!underHourlyCap_('submit', CONFIG.HOURLY_SUBMIT_CAP)) {
    throw LeadError_('rate_limited', 'Too many requests. Please wait a few minutes and try again.');
  }

  var at = new Date().toISOString();
  var value = check.value;
  lead.contact = { fullName: value.fullName, company: value.company, location: value.location, email: value.email, phone: value.phone };
  lead.consent = { privacyNoticeAcceptedAt: at, whatsappFollowUp: value.whatsappConsent };
  lead.status = 'SUBMITTED';
  lead.submittedAt = at;
  lead.updatedAt = at;
  pushHistory_(lead, { at: at, event: 'SUBMITTED', status: 'SUBMITTED' });
  writeLead_(found.row, lead, found.values);
  sendEmails_(enquiryEmails_(lead));
  return { lead: publicView_(lead), alreadySubmitted: false };
}

/** Unknown reference and wrong token look identical, so references cannot be probed. */
function authorise_(reference, token) {
  var notFound = LeadError_('not_found', 'Enquiry not found.');
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) throw notFound;
  var found = findLead_(reference);
  if (!found || typeof token !== 'string' || !token || !safeEqual_(sha256Hex_(token), found.lead.tokenHash)) throw notFound;
  return found;
}

function pushHistory_(lead, entry) {
  lead.history = (lead.history || []).concat([entry]).slice(-CONFIG.HISTORY_LIMIT);
}

function enquiryEmails_(lead) {
  var team = notifyEmail_();
  var internal = M.buildInternalNotification(lead);
  var ack = M.buildCustomerAcknowledgement(lead, team);
  return [
    { to: team, replyTo: lead.contact.email, subject: internal.subject, text: internal.text },
    { to: lead.contact.email, replyTo: team, subject: ack.subject, text: ack.text },
  ];
}

function sendEmails_(emails) {
  (emails || []).forEach(function (email) {
    if (!email || !email.to || !email.subject) return;
    try {
      MailApp.sendEmail({
        to: email.to,
        replyTo: email.replyTo || undefined,
        subject: email.subject,
        body: email.text || '',
        name: setting_('Company name') || 'PureLine Hygiene',
      });
    } catch (error) {
      console.error('Email to ' + email.to + ' failed: ' + error);
    }
  });
}

// =====================================================================================
// Rows from the optional Node server (signed with SHARED_SECRET)
// =====================================================================================

function handleSignedRow_(body) {
  var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || !safeEqual_(hmacHex_(body.payload, secret), body.signature)) throw LeadError_('forbidden', 'Invalid signature.');
  var message = JSON.parse(body.payload);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    upsertRegisterRow_(message.row || {});
  } finally {
    lock.releaseLock();
  }
  sendEmails_(message.emails || []);
  return { ok: true };
}

function upsertRegisterRow_(row) {
  var sheet = leadsSheet_();
  var rowNumber = findRowNumber_(sheet, row['Lead ID']);
  var previous = rowNumber ? sheet.getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0] : null;
  var values = registerValues_(row, previous);
  var full = values.concat(previous ? previous.slice(M.REGISTER_COLUMNS.length) : SYSTEM_COLUMNS.map(function () { return ''; }));
  if (rowNumber) sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues([full]);
  else sheet.appendRow(full);
}

// =====================================================================================
// Sheet storage
// =====================================================================================

function spreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function leadsSheet_() {
  var sheet = spreadsheet_().getSheetByName(CONFIG.SHEETS.leads);
  if (!sheet) throw new Error('The "Leads" tab is missing. Run setup from the Apps Script editor.');
  return sheet;
}

function findRowNumber_(sheet, reference) {
  var last = sheet.getLastRow();
  if (!reference || last < 2) return 0;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i += 1) if (String(ids[i][0]) === reference) return i + 2;
  return 0;
}

function findLead_(reference) {
  var sheet = leadsSheet_();
  var row = findRowNumber_(sheet, reference);
  if (!row) return null;
  var values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  return { row: row, values: values, lead: rowToLead_(values) };
}

function rowObject_(values) {
  var object = {};
  HEADERS.forEach(function (header, i) { object[header] = values[i]; });
  return object;
}

function isoOf_(value) {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : '';
}

function rowToLead_(values) {
  var r = rowObject_(values);
  return {
    id: String(r['Lead ID']),
    status: STATUS_CODES[r.Status] || 'DRAFT',
    createdAt: isoOf_(r.Created),
    submittedAt: isoOf_(r.Submitted) || null,
    updatedAt: isoOf_(r._updatedAt),
    requirements: parseJson_(r._requirements, {}),
    draftSnapshot: parseJson_(r._draftSnapshot, null),
    contact: r.Email
      ? { fullName: String(r.Name), company: String(r.Company || ''), location: String(r['Town/City']), email: String(r.Email), phone: String(r.Phone || '') }
      : null,
    consent: parseJson_(r._consent, null),
    tokenHash: String(r._tokenHash || ''),
    history: parseJson_(r._history, []),
  };
}

/** Stop spreadsheet formula injection: text that starts like a formula is stored as plain text. */
function safeCell_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/** Visible register values, keeping what staff own: staff statuses, notes and quote links. */
function registerValues_(row, previous) {
  var prev = previous ? rowObject_(previous) : null;
  return M.REGISTER_COLUMNS.map(function (column) {
    var value = row[column];
    if (prev) {
      if (M.STAFF_COLUMNS.indexOf(column) !== -1 && prev[column] !== '' && prev[column] != null) return prev[column];
      if (column === 'Status' && M.STAFF_STATUS_LABELS.indexOf(prev.Status) !== -1) return prev.Status;
    }
    if ((column === 'Submitted' || column === 'Created') && value) return new Date(value);
    return safeCell_(value == null ? '' : value);
  });
}

function writeLead_(rowNumber, lead, previous) {
  var sheet = leadsSheet_();
  var visible = registerValues_(M.toLeadRegisterRow(lead), previous);
  var system = [
    lead.tokenHash,
    lead.updatedAt,
    lead.consent ? JSON.stringify(lead.consent) : '',
    JSON.stringify(lead.requirements),
    lead.draftSnapshot ? JSON.stringify(lead.draftSnapshot) : '',
    JSON.stringify(lead.history || []),
  ];
  var values = visible.concat(system);
  if (rowNumber) sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues([values]);
  else sheet.appendRow(values);
}

function uniqueReference_() {
  var sheet = leadsSheet_();
  for (var attempt = 0; attempt < 8; attempt += 1) {
    var reference = 'PLH-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
    if (!findRowNumber_(sheet, reference)) return reference;
  }
  throw new Error('Could not allocate a unique lead reference');
}

/** Delete drafts nobody submitted within the retention period (runs daily from a trigger). */
function purgeDrafts() {
  var sheet = leadsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var cutoff = Date.now() - CONFIG.DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  var removed = 0;
  for (var i = rows.length - 1; i >= 0; i -= 1) {
    var r = rowObject_(rows[i]);
    var updated = Date.parse(isoOf_(r._updatedAt) || isoOf_(r.Created));
    if (r.Status === S.STATUS_LABELS.DRAFT && updated && updated < cutoff) {
      sheet.deleteRow(i + 2);
      removed += 1;
    }
  }
  if (removed) console.log('Removed ' + removed + ' expired draft(s)');
  return removed;
}

// =====================================================================================
// Settings, limits, crypto helpers
// =====================================================================================

var SETTINGS_DEFAULTS = [
  ['Notification email', '', 'New enquiries are emailed here. Also the reply-to address for customers.'],
  ['Company name', 'PureLine Hygiene', 'Shown on quotations and emails.'],
  ['Company registration no.', '', 'For quotations.'],
  ['VAT no.', '', 'For quotations (leave blank if not registered).'],
  ['Address', '', 'For quotations.'],
  ['Phone', '', 'For quotations.'],
  ['Bank name', '', 'Banking details printed on quotations.'],
  ['Account name', '', ''],
  ['Account number', '', ''],
  ['Branch code', '', ''],
  ['Quote valid for (days)', 30, 'How long a quotation is valid.'],
  ['Website', CONFIG.WEBSITE_URL, 'Used in links and quotations.'],
  ['Turnstile site key', '', 'Optional bot check. The secret goes in Project Settings → Script properties as TURNSTILE_SECRET.'],
];

var settingsCache_ = null;

function getSettings_() {
  if (settingsCache_) return settingsCache_;
  var settings = {};
  var sheet = spreadsheet_().getSheetByName(CONFIG.SHEETS.settings);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (pair) {
      if (pair[0]) settings[String(pair[0]).trim()] = pair[1];
    });
  }
  settingsCache_ = settings;
  return settings;
}

function setting_(name) {
  var value = getSettings_()[name];
  return value == null ? '' : String(value).trim();
}

function notifyEmail_() {
  return setting_('Notification email')
    || PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL')
    || Session.getEffectiveUser().getEmail();
}

function turnstileSiteKey_() {
  return setting_('Turnstile site key') && PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET')
    ? setting_('Turnstile site key')
    : '';
}

function verifyTurnstile_(token) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    var response = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post',
      payload: { secret: PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET'), response: token },
      muteHttpExceptions: true,
    });
    return JSON.parse(response.getContentText()).success === true;
  } catch (error) {
    console.error('Turnstile verification failed: ' + error);
    return false;
  }
}

/** Site-wide hourly caps (Apps Script cannot see visitor IP addresses, so there is no per-visitor limit). */
function underHourlyCap_(kind, max) {
  var cache = CacheService.getScriptCache();
  var key = 'cap:' + kind + ':' + Math.floor(Date.now() / 3600000);
  var count = Number(cache.get(key) || 0);
  if (count >= max) return false;
  cache.put(key, String(count + 1), 3700);
  return true;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sha256Hex_(text) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8));
}

function hmacHex_(text, secret) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(text, secret));
}

/** 256 bits from two random UUIDs. Only its SHA-256 hash is stored. */
function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson_(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

// =====================================================================================
// Staff tools: quotations and email replies (PureLine menu in the sheet)
// =====================================================================================

var EMAIL_TEMPLATES = [
  {
    name: 'Thanks, we are reviewing',
    subject: 'Your enquiry {{Lead ID}} – PureLine Hygiene',
    body: 'Dear {{Name}},\n\nThank you for your enquiry ({{Lead ID}}) for {{Quantity (pads)}} sanitary pads ({{Packs of 10}} packs of 10). Our team is reviewing your requirements and will send your quotation shortly.\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'We need more details',
    subject: 'More details for your enquiry {{Lead ID}}',
    body: 'Dear {{Name}},\n\nThank you for your enquiry ({{Lead ID}}). To prepare an accurate quotation, please send us:\n\n• your tender or order reference number\n• the product specification and any required standard (for example a SANS standard)\n• your packaging requirements\n• the delivery address and required delivery date\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'Your quotation is attached',
    subject: 'Quotation for enquiry {{Lead ID}} – PureLine Hygiene',
    body: 'Dear {{Name}},\n\nPlease find our quotation for {{Quantity (pads)}} sanitary pads ({{Packs of 10}} packs of 10) at {{Price per pad}} per pad ({{Price per pack}} per pack), {{Total}} in total.\n\nQuotation: {{Quote link}}\n\nThe quotation is valid until {{Valid until}}. Your order is confirmed once you accept the quotation in writing.\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'Price below our minimum',
    subject: 'Pricing for enquiry {{Lead ID}}',
    body: 'Dear {{Name}},\n\nThank you for your enquiry ({{Lead ID}}). The price you asked for, {{Price wanted /pad}} per pad, is below what we can currently offer. For {{Quantity (pads)}} pads we can supply at {{Price per pad}} per pad ({{Total}} in total).\n\nIf you can share your tender budget or flexibility on quantity or delivery, we will gladly look at the options with you.\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'Follow-up after 7 days',
    subject: 'Following up on your quotation {{Lead ID}}',
    body: 'Dear {{Name}},\n\nWe are following up on our quotation for enquiry {{Lead ID}}. Do you have any questions, or would you like us to adjust the quantity, packaging or delivery?\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'Order won – next steps',
    subject: 'Thank you for your order {{Lead ID}}',
    body: 'Dear {{Name}},\n\nThank you for accepting our quotation for enquiry {{Lead ID}}. Next steps:\n\n1. We send a pro-forma invoice.\n2. Please confirm the delivery point ({{Delivery point}}) and the delivery date.\n3. We confirm the production and delivery schedule.\n\nKind regards,\n{{Company name}}',
  },
  {
    name: 'Unable to supply',
    subject: 'Your enquiry {{Lead ID}}',
    body: 'Dear {{Name}},\n\nThank you for considering PureLine Hygiene for enquiry {{Lead ID}}. Unfortunately we are unable to supply this order at this time. We hope to work with you on a future requirement.\n\nKind regards,\n{{Company name}}',
  },
];

function formatMoney_(rands) {
  return rands === '' || rands == null ? '' : P.formatRand(Math.round(Number(rands) * 100));
}

function formatCount_(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDay_(date) {
  return Utilities.formatDate(date, 'Africa/Johannesburg', 'd MMMM yyyy');
}

/** Every {{placeholder}} value for quotations and email replies, from a Leads row and Settings. */
function placeholderValues_(r, settings, today) {
  var now = today || new Date();
  var validDays = Number(settings['Quote valid for (days)']) || 30;
  var value = function (key) { return settings[key] == null ? '' : String(settings[key]); };
  return {
    'Lead ID': String(r['Lead ID'] || ''),
    Date: formatDay_(now),
    'Valid until': formatDay_(new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000)),
    Name: String(r.Name || ''),
    Company: String(r.Company || '') || '—',
    'Town/City': String(r['Town/City'] || ''),
    Email: String(r.Email || ''),
    Phone: String(r.Phone || '') || '—',
    'Lead Type': String(r['Lead Type'] || ''),
    'Quantity (pads)': formatCount_(r['Quantity (pads)']),
    'Packs of 10': formatCount_(r['Packs of 10']),
    'Single pads': formatCount_(r['Single pads']),
    'Price per pad': formatMoney_(r['Our price /pad']),
    'Price per pack': formatMoney_(Number(r['Our price /pad']) * P.PACK_SIZE),
    Total: formatMoney_(r['Our total']),
    'Price wanted /pad': formatMoney_(r['Price wanted /pad']),
    'Price wanted /pack': formatMoney_(r['Price wanted /pack']),
    'Customer total': formatMoney_(r['Customer total']),
    'Stickers/Decals': r['Stickers/Decals'] === 'Yes' ? 'Yes – stickers/decals on packs (we do not print)' : 'No – plain white heat-sealed packs',
    Delivery: r.Delivery === 'Collect' ? 'Collection by customer' : 'Delivery to ' + (String(r['Delivery point'] || '') || 'delivery point to be confirmed'),
    'Delivery point': String(r['Delivery point'] || '') || 'to be confirmed',
    'Quote link': String(r['Quote link'] || ''),
    'Company name': value('Company name') || 'PureLine Hygiene',
    'Company registration no.': value('Company registration no.'),
    'VAT no.': value('VAT no.'),
    Address: value('Address'),
    'Company phone': value('Phone'),
    'Bank name': value('Bank name'),
    'Account name': value('Account name'),
    'Account number': value('Account number'),
    'Branch code': value('Branch code'),
    Website: value('Website') || CONFIG.WEBSITE_URL,
  };
}

function fillPlaceholders_(text, values) {
  return String(text).replace(/\{\{([^{}]+)\}\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

function escapeRegex_(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function selectedLead_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== CONFIG.SHEETS.leads) throw new Error('Open the Leads tab and click a lead row first.');
  var row = sheet.getActiveRange().getRow();
  if (row < 2) throw new Error('Click a lead row (not the header) first.');
  var values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  var r = rowObject_(values);
  if (!r['Lead ID'] || !r.Email) throw new Error('This row has no submitted contact details yet. Pick a submitted enquiry.');
  return { sheet: sheet, row: row, record: r };
}

function columnNumber_(header) {
  return HEADERS.indexOf(header) + 1;
}

/** Copies the quotation template into Quotes/, fills it from the row and Settings, links it. */
function createQuotationForRow_(sheet, row, record) {
  var props = PropertiesService.getScriptProperties();
  var templateId = props.getProperty('QUOTE_TEMPLATE_ID');
  var quotesId = props.getProperty('QUOTES_FOLDER_ID');
  if (!templateId || !quotesId) throw new Error('Run setup first: the quotation template is not set up yet.');
  var values = placeholderValues_(record, getSettings_());
  var name = 'Quotation ' + values['Lead ID'] + ' – ' + (record.Company || record.Name);
  var copy = DriveApp.getFileById(templateId).makeCopy(name, DriveApp.getFolderById(quotesId));
  var doc = DocumentApp.openById(copy.getId());
  [doc.getBody(), doc.getHeader(), doc.getFooter()].forEach(function (section) {
    if (!section) return;
    Object.keys(values).forEach(function (key) {
      section.replaceText(escapeRegex_('{{' + key + '}}'), values[key]);
    });
  });
  doc.saveAndClose();
  var url = copy.getUrl();
  sheet.getRange(row, columnNumber_('Quote link')).setValue(url);
  var status = String(record.Status);
  if (['Submitted', 'Under Review', 'Contacted'].indexOf(status) !== -1) sheet.getRange(row, columnNumber_('Status')).setValue('Quoted');
  return url;
}

/** Creates a Gmail draft (never sends) from one of EMAIL_TEMPLATES for the selected row. */
function draftReplyForRecord_(record, templateIndex) {
  var template = EMAIL_TEMPLATES[templateIndex];
  var values = placeholderValues_(record, getSettings_());
  var subject = fillPlaceholders_(template.subject, values);
  var body = fillPlaceholders_(template.body, values);
  GmailApp.createDraft(String(record.Email), subject, body, { name: values['Company name'] });
  return { subject: subject };
}

// ---- Menu (functions called from the menu must be global and must not end in "_") ----

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var replies = ui.createMenu('Draft email reply for selected lead');
  EMAIL_TEMPLATES.forEach(function (template, i) { replies.addItem((i + 1) + '. ' + template.name, 'emailReply' + (i + 1)); });
  ui.createMenu('PureLine')
    .addItem('Create quotation for selected lead', 'createQuotation')
    .addSubMenu(replies)
    .addSeparator()
    .addItem('Open dashboard', 'openDashboard')
    .addItem('Delete expired drafts now', 'purgeDrafts')
    .addItem('Run setup again', 'setup')
    .addToUi();
}

function createQuotation() {
  var ui = SpreadsheetApp.getUi();
  try {
    var selected = selectedLead_();
    var url = createQuotationForRow_(selected.sheet, selected.row, selected.record);
    ui.alert('Quotation created', 'Saved in the Quotes folder and linked in the "Quote link" column:\n\n' + url + '\n\nCheck the prices before sending it.', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Could not create the quotation', error.message, ui.ButtonSet.OK);
  }
}

function emailReplyFromMenu_(index) {
  var ui = SpreadsheetApp.getUi();
  try {
    var draft = draftReplyForRecord_(selectedLead_().record, index);
    ui.alert('Gmail draft created', '"' + draft.subject + '" is in Gmail → Drafts. Review it, attach the quotation if needed, then send.', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Could not create the draft', error.message, ui.ButtonSet.OK);
  }
}

function emailReply1() { emailReplyFromMenu_(0); }
function emailReply2() { emailReplyFromMenu_(1); }
function emailReply3() { emailReplyFromMenu_(2); }
function emailReply4() { emailReplyFromMenu_(3); }
function emailReply5() { emailReplyFromMenu_(4); }
function emailReply6() { emailReplyFromMenu_(5); }
function emailReply7() { emailReplyFromMenu_(6); }

function openDashboard() {
  var sheet = spreadsheet_().getSheetByName(CONFIG.SHEETS.dashboard);
  if (sheet) sheet.activate();
}

// =====================================================================================
// setup(): run once from the editor. Safe to run again; it keeps existing data.
// =====================================================================================

function setup() {
  var ss = spreadsheet_();
  var props = PropertiesService.getScriptProperties();

  // ---- Drive folders: the sheet lives in "PureLine Hygiene" with Templates/ and Quotes/ ----
  var sheetFile = DriveApp.getFileById(ss.getId());
  var folder = findOrCreateFolder_(null, CONFIG.FOLDER_NAME);
  var inFolder = false;
  var parents = sheetFile.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folder.getId()) inFolder = true;
  if (!inFolder) sheetFile.moveTo(folder);
  var templates = findOrCreateFolder_(folder, 'Templates');
  var quotes = findOrCreateFolder_(folder, 'Quotes');
  props.setProperty('FOLDER_ID', folder.getId());
  props.setProperty('QUOTES_FOLDER_ID', quotes.getId());

  // ---- Tabs ----
  var tabs = CONFIG.SHEETS;
  var leads = ensureSheet_(ss, tabs.leads, 1);
  var settings = ensureSheet_(ss, tabs.settings, 2);
  var help = ensureSheet_(ss, tabs.help, 3);
  var dashboard = ensureSheet_(ss, tabs.dashboard, 0);
  var chartData = ensureSheet_(ss, tabs.chartData, 99); // last tab
  setupLeadsSheet_(leads);
  setupSettingsSheet_(settings);
  setupHelpSheet_(help);
  ['Sheet1', 'Blad1'].forEach(function (name) {
    var blank = ss.getSheetByName(name);
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  });

  // ---- Template documents ----
  var quoteTemplate = ensureDoc_(props, 'QUOTE_TEMPLATE_ID', 'Quotation template', templates, buildQuotationTemplate_);
  var emailTemplates = ensureDoc_(props, 'EMAIL_TEMPLATES_ID', 'Email reply templates', templates, buildEmailTemplatesDoc_);

  var links = {
    sheet: ss.getUrl(),
    leads: ss.getUrl() + '#gid=' + leads.getSheetId(),
    settings: ss.getUrl() + '#gid=' + settings.getSheetId(),
    folder: folder.getUrl(),
    templates: templates.getUrl(),
    quotes: quotes.getUrl(),
    quoteTemplate: quoteTemplate.getUrl(),
    emailTemplates: emailTemplates.getUrl(),
    website: setting_('Website') || CONFIG.WEBSITE_URL,
    script: 'https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/edit',
    gmail: 'https://mail.google.com/mail/u/0/#inbox',
  };
  var startHere = ensureDoc_(props, 'START_HERE_ID', 'START HERE – admin links', folder, function (doc) { buildStartHereDoc_(doc, links); });
  links.startHere = startHere.getUrl();
  setupDashboard_(dashboard, links);
  setupChartData_(chartData);
  setupCharts_(dashboard, chartData);
  dashboard.activate();

  // ---- Daily clean-up of abandoned drafts ----
  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'purgeDrafts'; });
  if (!hasTrigger) ScriptApp.newTrigger('purgeDrafts').timeBased().everyDays(1).atHour(2).create();

  // Touch the services the web app needs, so their permissions are approved now.
  MailApp.getRemainingDailyQuota();
  GmailApp.getAliases();
  console.log('Setup complete. Folder: ' + folder.getUrl());
  return links;
}

function findOrCreateFolder_(parent, name) {
  var found = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  if (found.hasNext()) return found.next();
  return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
}

function ensureSheet_(ss, name, index) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name, Math.min(index, ss.getSheets().length));
  return sheet;
}

/** Re-uses the document whose id is stored in a script property, otherwise creates and fills it. */
function ensureDoc_(props, key, name, folder, build) {
  var id = props.getProperty(key);
  if (id) {
    try {
      var existing = DriveApp.getFileById(id);
      if (!existing.isTrashed()) return existing;
    } catch (error) {
      /* deleted: create a new one */
    }
  }
  var found = folder.getFilesByName(name);
  if (found.hasNext()) {
    var file = found.next();
    props.setProperty(key, file.getId());
    return file;
  }
  var doc = DocumentApp.create(name);
  build(doc);
  doc.saveAndClose();
  var created = DriveApp.getFileById(doc.getId());
  created.moveTo(folder);
  props.setProperty(key, created.getId());
  return created;
}

var BRAND = { ink: '#14232a', teal: '#2f6f68', paper: '#f4f2ec', aqua: '#e6f2ef', grey: '#efefef', green: '#e3f3e8', amber: '#fbf4e4' };

function setupLeadsSheet_(sheet) {
  var header = sheet.getRange(1, 1, 1, HEADERS.length);
  var current = sheet.getLastRow() ? header.getValues()[0] : [];
  if (current.join('|') !== HEADERS.join('|')) {
    if (sheet.getLastRow() > 1 && current[0] !== 'Lead ID') throw new Error('The Leads tab has data in an unexpected layout. Rename it and run setup again.');
    header.setValues([HEADERS]);
  }
  header.setFontWeight('bold').setBackground(BRAND.ink).setFontColor('#ffffff').setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  if (sheet.getMaxColumns() > HEADERS.length) sheet.deleteColumns(HEADERS.length + 1, sheet.getMaxColumns() - HEADERS.length);
  sheet.hideColumns(M.REGISTER_COLUMNS.length + 1, SYSTEM_COLUMNS.length);

  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var col = function (name) { return sheet.getRange(2, columnNumber_(name), rows, 1); };
  ['Submitted', 'Created'].forEach(function (name) { col(name).setNumberFormat('d mmm yyyy hh:mm'); });
  ['Quantity (pads)', 'Packs of 10', 'Single pads'].forEach(function (name) { col(name).setNumberFormat('#,##0'); });
  ['Price wanted /pad', 'Price wanted /pack', 'Our price /pad'].forEach(function (name) { col(name).setNumberFormat('"R"#,##0.00'); });
  ['Customer total', 'Our total'].forEach(function (name) { col(name).setNumberFormat('"R"#,##0.00'); });
  col('Status').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(S.LEAD_STATUSES.map(function (s) { return S.STATUS_LABELS[s]; }), true).build()
  );
  col('Staff notes').setWrap(true);

  var widths = { 'Lead ID': 120, Status: 110, Submitted: 140, Created: 140, Name: 150, Company: 160, Email: 200, 'Delivery point': 200, 'Staff notes': 240, 'Quote link': 160 };
  M.REGISTER_COLUMNS.forEach(function (name, i) { sheet.setColumnWidth(i + 1, widths[name] || 110); });

  // Row colours by status: draft grey, new submission highlighted, won green, lost faded.
  var area = sheet.getRange(2, 1, rows, M.REGISTER_COLUMNS.length);
  var rule = function (label, background, fontColor) {
    var builder = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$B2="' + label + '"').setBackground(background).setRanges([area]);
    if (fontColor) builder.setFontColor(fontColor);
    return builder.build();
  };
  sheet.setConditionalFormatRules([
    rule('Draft', BRAND.grey, '#777777'),
    rule('Submitted', BRAND.amber),
    rule('Quoted', BRAND.aqua),
    rule('Won', BRAND.green),
    rule('Lost', '#f6f6f6', '#999999'),
  ]);
  if (!sheet.getFilter()) sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), M.REGISTER_COLUMNS.length).createFilter();
}

function setupSettingsSheet_(sheet) {
  if (sheet.getLastRow() < 2) {
    var rows = SETTINGS_DEFAULTS.map(function (row) {
      return row[0] === 'Notification email' ? [row[0], Session.getEffectiveUser().getEmail(), row[2]] : row;
    });
    sheet.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'Notes']]);
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  } else {
    // Add any settings introduced since the last setup, without touching existing values.
    var existing = getSettings_();
    SETTINGS_DEFAULTS.forEach(function (row) { if (!(row[0] in existing)) sheet.appendRow(row); });
  }
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground(BRAND.ink).setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 420);
  settingsCache_ = null;
}

function setupHelpSheet_(sheet) {
  var rows = [
    ['How to use the PureLine lead register', ''],
    ['', ''],
    ['Status', 'What it means'],
    ['Draft', 'The visitor saved requirements on the website but has not submitted contact details. Drafts are deleted automatically after 30 days.'],
    ['Submitted', 'A new enquiry. You and the customer were emailed. Review it.'],
    ['Under Review', 'Someone is working on it.'],
    ['Contacted', 'You have spoken to or emailed the customer.'],
    ['Quoted', 'A quotation was created (PureLine menu → Create quotation) and sent.'],
    ['Won', 'The customer accepted the quotation in writing.'],
    ['Lost', 'The customer declined, or we could not supply.'],
    ['', ''],
    ['What you may edit', 'Status, Staff notes and Quote link. The website never overwrites these.'],
    ['Please do not edit', 'Lead ID or the calculator columns. Hidden columns (after Quote link) are used by the website: do not unhide or change them.'],
    ['Quotation', 'Click a submitted lead row, then PureLine menu → Create quotation for selected lead. It is saved in the Quotes folder.'],
    ['Email replies', 'Click a lead row, then PureLine menu → Draft email reply. A Gmail draft is created for you to check and send; nothing is sent automatically.'],
    ['Settings', 'Company details, banking details and the notification email live on the Settings tab.'],
    ['Dashboard charts', 'The Dashboard charts update by themselves from the Leads tab (via the "Chart data" tab). Drafts are not counted.'],
  ];
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(3, 1, 1, 2).setFontWeight('bold').setBackground(BRAND.ink).setFontColor('#ffffff');
  sheet.getRange(12, 1, 6, 1).setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 640);
  sheet.getRange(1, 2, rows.length, 1).setWrap(true);
}

function setupDashboard_(sheet, links) {
  var link = function (url, label) { return '=HYPERLINK("' + url + '","' + label + '")'; };
  var L = "'" + CONFIG.SHEETS.leads + "'!";
  var countStatus = function (label) { return '=COUNTIF(' + L + 'B:B,"' + label + '")'; };
  var notDraft = L + 'B:B,"<>Draft",' + L + 'A:A,"<>"';
  var rows = [
    ['PureLine Hygiene – enquiries dashboard', '', '', ''],
    ['Updated live from the Leads tab.', '', '', ''],
    ['', '', '', ''],
    ['QUICK LINKS', '', 'AT A GLANCE', ''],
    [link(links.leads, '→ All leads'), '', 'New (Submitted)', countStatus('Submitted')],
    [link(links.quoteTemplate, '→ Quotation template'), '', 'Under review', countStatus('Under Review')],
    [link(links.emailTemplates, '→ Email reply templates'), '', 'Contacted', countStatus('Contacted')],
    [link(links.quotes, '→ Quotes folder'), '', 'Quoted', countStatus('Quoted')],
    [link(links.folder, '→ PureLine Hygiene folder'), '', 'Won', countStatus('Won')],
    [link(links.settings, '→ Settings (company & bank details)'), '', 'Lost', countStatus('Lost')],
    [link(links.startHere || links.folder, '→ START HERE guide'), '', 'Drafts (not submitted)', countStatus('Draft')],
    [link(links.website, '→ Website'), '', 'Pads requested this month', '=SUMIFS(' + L + 'L:L,' + L + 'C:C,">="&(EOMONTH(TODAY(),-1)+1),' + notDraft + ')'],
    [link(links.gmail, '→ Gmail inbox'), '', 'Pads requested in total', '=SUMIFS(' + L + 'L:L,' + notDraft + ')'],
    [link(links.script, '→ Apps Script editor'), '', 'Value at customer prices', '=SUMIFS(' + L + 'Q:Q,' + notDraft + ')'],
    ['', '', 'Value at our prices', '=SUMIFS(' + L + 'S:S,' + notDraft + ')'],
    ['', '', 'Secured tenders', '=COUNTIFS(' + L + 'K:K,"Tender",' + notDraft + ')'],
    ['', '', 'Preparing tenders', '=COUNTIFS(' + L + 'K:K,"Preparation",' + notDraft + ')'],
    ['', '', 'Organisations', '=COUNTIFS(' + L + 'K:K,"Organisation",' + notDraft + ')'],
    ['', '', 'Bulk supply', '=COUNTIFS(' + L + 'K:K,"Bulk",' + notDraft + ')'],
    ['', '', '', ''],
    ['LATEST 10 SUBMITTED ENQUIRIES', '', '', ''],
  ];
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 4).setValues(rows);
  sheet.getRange(rows.length + 1, 1).setFormula(
    '=IFERROR(QUERY(' + L + 'A2:S,"select A, E, F, L, Q, B, C where B <> \'Draft\' and A is not null order by C desc limit 10 label A \'Lead ID\', E \'Name\', F \'Company\', L \'Pads\', Q \'Customer total\', B \'Status\', C \'Submitted\'",0),"No submitted enquiries yet")'
  );
  sheet.getRange(1, 1).setFontSize(18).setFontWeight('bold').setFontColor(BRAND.ink);
  sheet.getRange(2, 1).setFontColor('#777777');
  [sheet.getRange(4, 1, 1, 2), sheet.getRange(4, 3, 1, 2), sheet.getRange(rows.length, 1, 1, 7)].forEach(function (range) {
    range.setFontWeight('bold').setBackground(BRAND.ink).setFontColor('#ffffff');
  });
  sheet.getRange(5, 1, 10, 1).setFontWeight('bold').setFontColor(BRAND.teal);
  sheet.getRange(5, 4, 15, 1).setFontWeight('bold').setHorizontalAlignment('right');
  sheet.getRange(12, 4, 2, 1).setNumberFormat('#,##0');
  sheet.getRange(14, 4, 2, 1).setNumberFormat('"R"#,##0.00');
  sheet.getRange(rows.length + 2, 4, 10, 1).setNumberFormat('#,##0');
  sheet.getRange(rows.length + 2, 5, 10, 1).setNumberFormat('"R"#,##0.00');
  sheet.getRange(rows.length + 2, 7, 10, 1).setNumberFormat('d mmm yyyy');
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 30);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 140);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor(BRAND.teal);
}

// ---- Charts: the Dashboard charts read from live formulas on the "Chart data" tab ----

var CHART_COLORS = ['#2f6f68', '#d9a441', '#14232a', '#9fd8cf', '#b5472f', '#7a8c8f'];

/** Cell blocks on "Chart data" (row 3 headers, data below). Shared by setupChartData_ and setupCharts_. */
var CHART_BLOCKS = {
  status: { range: 'A3:B9' },
  type: { range: 'D3:E7' },
  monthly: { range: 'G3:K9' },
  delivery: { range: 'M3:N5' },
  stickers: { range: 'P3:Q5' },
};

function chartDataRows_() {
  var L = "'" + CONFIG.SHEETS.leads + "'!";
  var notDraft = L + 'B:B,"<>Draft",' + L + 'A:A,"<>"';
  var statuses = ['Submitted', 'Under Review', 'Contacted', 'Quoted', 'Won', 'Lost'];
  var types = ['Tender', 'Preparation', 'Organisation', 'Bulk'];
  var blocks = {};
  blocks.status = [['Status', 'Enquiries']].concat(statuses.map(function (label, i) {
    return [label, '=COUNTIF(' + L + 'B:B,A' + (4 + i) + ')'];
  }));
  blocks.type = [['Customer type', 'Enquiries']].concat(types.map(function (label, i) {
    return [label, '=COUNTIFS(' + L + 'K:K,D' + (4 + i) + ',' + notDraft + ')'];
  }));
  blocks.monthly = [['Month', 'Enquiries', 'Pads requested', 'Value (customer prices)', 'Value (our prices)']];
  for (var m = 0; m < 6; m += 1) {
    var row = 4 + m;
    var inMonth = L + 'C:C,">="&G' + row + ',' + L + 'C:C,"<"&(EOMONTH(G' + row + ',0)+1),' + notDraft;
    blocks.monthly.push([
      '=EOMONTH(TODAY(),' + (m - 6) + ')+1',
      '=COUNTIFS(' + inMonth + ')',
      '=SUMIFS(' + L + 'L:L,' + inMonth + ')',
      '=SUMIFS(' + L + 'Q:Q,' + inMonth + ')',
      '=SUMIFS(' + L + 'S:S,' + inMonth + ')',
    ]);
  }
  blocks.delivery = [['Delivery', 'Enquiries'],
    ['Delivery', '=COUNTIFS(' + L + 'V:V,"Deliver",' + notDraft + ')'],
    ['Collection', '=COUNTIFS(' + L + 'V:V,"Collect",' + notDraft + ')']];
  blocks.stickers = [['Packaging', 'Enquiries'],
    ['Stickers/decals', '=COUNTIFS(' + L + 'U:U,"Yes",' + notDraft + ')'],
    ['Plain white packs', '=COUNTIFS(' + L + 'U:U,"No",' + notDraft + ')']];
  return blocks;
}

function setupChartData_(sheet) {
  var blocks = chartDataRows_();
  sheet.clear();
  sheet.getRange(1, 1).setValue('Chart data – do not edit. The Dashboard charts read from these live formulas (drafts are not counted).');
  sheet.getRange(1, 1).setFontWeight('bold').setFontColor('#777777');
  Object.keys(CHART_BLOCKS).forEach(function (key) {
    var range = sheet.getRange(CHART_BLOCKS[key].range);
    range.setValues(blocks[key]);
    range.offset(0, 0, 1).setFontWeight('bold').setBackground(BRAND.ink).setFontColor('#ffffff');
  });
  sheet.getRange('G4:G9').setNumberFormat('mmm yyyy');
  sheet.getRange('I4:I9').setNumberFormat('#,##0');
  sheet.getRange('J4:K9').setNumberFormat('"R"#,##0.00');
  sheet.setTabColor('#999999');
}

function setupCharts_(dashboard, data) {
  dashboard.getCharts().forEach(function (chart) { dashboard.removeChart(chart); });
  var place = [[4, 9], [4, 15], [18, 9], [18, 15], [32, 9], [32, 15]];
  var common = function (builder, title, index) {
    return builder
      .setPosition(place[index][0], place[index][1], 0, 0)
      .setOption('title', title)
      .setOption('titleTextStyle', { color: BRAND.ink, fontSize: 14, bold: true })
      .setOption('width', 440)
      .setOption('height', 270)
      .setOption('colors', CHART_COLORS)
      .setNumHeaders(1);
  };
  var pie = function (range, title, index) {
    return common(dashboard.newChart().setChartType(Charts.ChartType.PIE).addRange(data.getRange(range)), title, index)
      .setOption('pieHole', 0.45)
      .setOption('legend', { position: 'right' })
      .setOption('sliceVisibilityThreshold', 0)
      .build();
  };
  var columns = function (ranges, title, index) {
    var builder = dashboard.newChart().setChartType(Charts.ChartType.COLUMN);
    ranges.forEach(function (range) { builder.addRange(data.getRange(range)); });
    return common(builder, title, index).setOption('legend', { position: 'none' }).build();
  };
  [
    pie('A3:B9', 'Enquiries by status', 0),
    pie('D3:E7', 'Enquiries by customer type', 1),
    columns(['G3:G9', 'H3:H9'], 'Enquiries per month', 2),
    columns(['G3:G9', 'I3:I9'], 'Pads requested per month', 3),
    pie('M3:N5', 'Delivery or collection', 4),
    pie('P3:Q5', 'Stickers/decals or plain packs', 5),
  ].forEach(function (chart) { dashboard.insertChart(chart); });
}

// ---- Template documents ----

function heading_(body, text, level) {
  return body.appendParagraph(text).setHeading(level || DocumentApp.ParagraphHeading.HEADING2);
}

function buildQuotationTemplate_(doc) {
  var body = doc.getBody();
  var H = DocumentApp.ParagraphHeading;
  body.clear();
  heading_(body, '{{Company name}}', H.TITLE);
  body.appendParagraph('{{Address}} · {{Company phone}} · {{Website}}');
  body.appendParagraph('Reg. no. {{Company registration no.}} · VAT no. {{VAT no.}}');
  heading_(body, 'QUOTATION', H.HEADING1);
  body.appendTable([
    ['Quotation for enquiry', '{{Lead ID}}'],
    ['Date', '{{Date}}'],
    ['Valid until', '{{Valid until}}'],
  ]);
  heading_(body, 'Customer');
  body.appendTable([
    ['Name', '{{Name}}'],
    ['Company / organisation', '{{Company}}'],
    ['Town or city', '{{Town/City}}'],
    ['Email', '{{Email}}'],
    ['Phone', '{{Phone}}'],
  ]);
  heading_(body, 'Supply');
  body.appendTable([
    ['Item', 'Quantity', 'Price', 'Amount'],
    ['Sanitary pads, individually wrapped', '{{Quantity (pads)}} pads ({{Packs of 10}} packs of 10)', '{{Price per pad}} per pad ({{Price per pack}} per pack)', '{{Total}}'],
    ['', '', 'Total', '{{Total}}'],
  ]);
  body.appendParagraph('Packaging: plain white heat-sealed packs. {{Stickers/Decals}}.');
  body.appendParagraph('Delivery: {{Delivery}}.');
  body.appendParagraph('Your requested price was {{Price wanted /pad}} per pad ({{Price wanted /pack}} per pack).').editAsText().setItalic(true);
  heading_(body, 'Banking details');
  body.appendTable([
    ['Bank', '{{Bank name}}'],
    ['Account name', '{{Account name}}'],
    ['Account number', '{{Account number}}'],
    ['Branch code', '{{Branch code}}'],
    ['Reference', '{{Lead ID}}'],
  ]);
  heading_(body, 'Terms');
  body.appendListItem('This quotation is valid until {{Valid until}}.');
  body.appendListItem('An order is confirmed only once you accept this quotation in writing.');
  body.appendListItem('We do not print on packaging; packs can be made specific to your order with stickers or decals.');
  body.appendListItem('Compliance documents (for example SABS/SANS and B-BBEE) are provided on request.');
}

function buildEmailTemplatesDoc_(doc) {
  var body = doc.getBody();
  body.clear();
  heading_(body, 'PureLine Hygiene – email reply templates', DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(
    'Quickest way: in the lead sheet, click a lead row and use PureLine menu → Draft email reply. ' +
    'The {{placeholders}} are filled in for you and a Gmail draft is created for you to check and send. ' +
    'You can also copy a template from here by hand.'
  );
  EMAIL_TEMPLATES.forEach(function (template, i) {
    heading_(body, (i + 1) + '. ' + template.name);
    body.appendParagraph('Subject: ' + template.subject).editAsText().setBold(true);
    template.body.split('\n').forEach(function (line) { body.appendParagraph(line).editAsText().setBold(false); });
  });
}

function buildStartHereDoc_(doc, links) {
  var body = doc.getBody();
  var H = DocumentApp.ParagraphHeading;
  body.clear();
  heading_(body, 'PureLine Hygiene – START HERE', H.TITLE);
  body.appendParagraph(
    'How a lead flows: a visitor uses the calculator on the website and saves their requirements (a Draft row appears in the Leads tab). ' +
    'When they add their contact details and submit, the row becomes Submitted and two emails go out: one to the notification email ' +
    'in Settings and an acknowledgement to the customer. Staff then review the lead, create a quotation from the PureLine menu and ' +
    'reply using the email templates.'
  );
  heading_(body, 'Quick links');
  [
    ['Lead register (dashboard)', links.sheet],
    ['All leads', links.leads],
    ['Settings (company and bank details)', links.settings],
    ['Quotation template', links.quoteTemplate],
    ['Email reply templates', links.emailTemplates],
    ['Quotes folder', links.quotes],
    ['Website', links.website],
    ['Apps Script editor', links.script],
  ].forEach(function (item) {
    body.appendListItem(item[0]).setLinkUrl(item[1]);
  });
  heading_(body, 'Daily work');
  ['Open the dashboard and check New (Submitted).', 'Set the Status as you work: Under Review → Contacted → Quoted → Won or Lost.',
    'Create a quotation: click the lead row → PureLine → Create quotation for selected lead. Check the prices, then send it.',
    'Reply: click the lead row → PureLine → Draft email reply → pick a template. Review the Gmail draft and send.'].forEach(function (text) {
    body.appendListItem(text).setGlyphType(DocumentApp.GlyphType.NUMBER);
  });
  heading_(body, 'Test checklist (before going live)');
  ['On the website preview, choose a quantity and price, then Save and continue: a Draft row appears.',
    'Refresh the page: your draft comes back. Change the quantity: the row updates.',
    'Add contact details and Submit: the row becomes Submitted and both emails arrive.',
    'Press Submit again: no second email.',
    'Create a quotation for the row and open it from the Quote link column.',
    'Draft an email reply and check it in Gmail → Drafts.',
    'Delete the test rows when finished.'].forEach(function (text) {
    body.appendListItem(text).setGlyphType(DocumentApp.GlyphType.BULLET);
  });
  heading_(body, 'Switching to the business account');
  body.appendParagraph(
    'Sign in as the business Google account, create a new Google Sheet, open Extensions → Apps Script, paste Code.gs, run setup and deploy it ' +
    'as a web app (Execute as: Me, Who has access: Anyone). Send the new /exec URL to the developer to put in the website settings. ' +
    'Alternatively change "Notification email" in Settings to the business address.'
  );
}
