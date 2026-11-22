/**
 * PureLine Hygiene — Google Sheets lead register (TEMPLATE, NOT DEPLOYED).
 *
 * Setup, once the business Google account is available:
 * 1. Create a Google Sheet with a tab named "Leads".
 * 2. Extensions → Apps Script, paste this file.
 * 3. Project Settings → Script properties: add SHARED_SECRET (same value as the website server's
 *    APPS_SCRIPT_SHARED_SECRET). Never put the secret in the website's browser code.
 * 4. Deploy → New deployment → Web app, execute as "Me", access "Anyone".
 * 5. Set the deployment URL as APPS_SCRIPT_WEBHOOK_URL on the website server.
 *
 * The server sends { payload, signature } where signature = HMAC-SHA-256(payload, SHARED_SECRET).
 * Rows are upserted by Lead ID, so a draft row is updated in place when the enquiry is submitted.
 *
 * Emails: for a submitted enquiry the payload carries two emails, the internal notification (to the
 * business address) and the customer acknowledgement. They are sent from the Google account that owns
 * this script (MailApp), so deploy it from the business Gmail account. Approve the "send email as you"
 * permission when Apps Script asks on first deployment. Consumer Gmail allows about 100 recipients a day.
 * Staff manage the Status column (Under Review, Contacted, Quoted, Won, Lost) directly in the Sheet.
 */

var COLUMNS = ['Lead ID', 'Date', 'Name', 'Company', 'Location', 'Email', 'Phone', 'Quantity',
  'Unit Price', 'Total', 'Price Wanted', 'Pack Price Wanted', 'Estimated Selling Price',
  'Stickers/Decals', 'Delivery', 'Delivery Point', 'Lead Type', 'Status'];

// Statuses staff have moved a lead to; the website never overwrites these.
var STAFF_STATUSES = ['Under Review', 'Contacted', 'Quoted', 'Won', 'Lost'];

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || !verifySignature_(body.payload, body.signature, secret)) {
    return json_({ ok: false, error: 'invalid signature' });
  }

  var message = JSON.parse(body.payload);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    upsertRow_(message.row);
  } finally {
    lock.releaseLock();
  }
  sendEmails_(message.emails || []);
  return json_({ ok: true });
}

function verifySignature_(payload, signature, secret) {
  var bytes = Utilities.computeHmacSha256Signature(payload, secret);
  var expected = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  if (typeof signature !== 'string' || signature.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

function upsertRow_(row) {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Leads');
  if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);

  var values = COLUMNS.map(function (column) {
    var value = row[column] === undefined ? '' : String(row[column]);
    return /^[=+\-@]/.test(value) ? "'" + value : value; // no formula injection
  });

  var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var r = 1; r < ids.length; r++) {
    if (ids[r][0] === row['Lead ID']) {
      var statusCell = sheet.getRange(r + 1, COLUMNS.indexOf('Status') + 1);
      if (STAFF_STATUSES.indexOf(statusCell.getValue()) !== -1) values[COLUMNS.indexOf('Status')] = statusCell.getValue();
      sheet.getRange(r + 1, 1, 1, COLUMNS.length).setValues([values]);
      return;
    }
  }
  sheet.appendRow(values);
}

function sendEmails_(emails) {
  emails.forEach(function (email) {
    if (!email || !email.to || !email.subject) return;
    try {
      MailApp.sendEmail({
        to: email.to,
        replyTo: email.replyTo || undefined,
        subject: email.subject,
        body: email.text || '',
        name: 'PureLine Hygiene',
      });
    } catch (error) {
      console.error('Email to ' + email.to + ' failed: ' + error);
    }
  });
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
