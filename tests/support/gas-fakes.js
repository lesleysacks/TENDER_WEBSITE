'use strict';

/*
 * In-memory stand-ins for the Google Apps Script services used by apps-script/Backend.js, so the
 * built dist/apps-script/Code.gs can be exercised in Node (unit tests and the local e2e stand-in).
 * Only what the backend uses is modelled; formatting calls are accepted and ignored.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'apps-script', 'Code.gs');

/** Any unknown method returns the same object, so chains like range.setFontWeight().setBackground() work. */
function chainable(target = {}) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => proxy;
    },
  });
  return proxy;
}

const iterator = (items) => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

let idCounter = 0;
const newId = (prefix) => `${prefix}${(idCounter += 1).toString(36)}${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------- Sheets

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
    return chainable(this);
  }
  getRow() { return this.row; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r += 1) {
      const line = [];
      for (let c = 0; c < this.cols; c += 1) line.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    values.forEach((line, r) => line.forEach((value, c) => this.sheet.write(this.row + r, this.col + c, value)));
    return this;
  }
  setValue(value) { this.sheet.write(this.row, this.col, value); return this; }
  setFormula(formula) { this.sheet.write(this.row, this.col, formula); return this; }
  createFilter() { this.sheet.filter = {}; return this.sheet.filter; }
}

class FakeSheet {
  constructor(spreadsheet, name) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.id = Math.floor(Math.random() * 1e9);
    this.raw = []; // values as written (including a leading apostrophe that Sheets hides)
    this.filter = null;
    this.activeRow = 2;
    return chainable(this);
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  write(row, col, value) {
    while (this.raw.length < row) this.raw.push([]);
    this.raw[row - 1][col - 1] = value;
  }
  cell(row, col) {
    const value = (this.raw[row - 1] || [])[col - 1];
    if (value === undefined || value === null) return '';
    // Like Sheets: a leading apostrophe forces text and is not part of the value.
    return typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
  }
  getLastRow() {
    for (let r = this.raw.length; r > 0; r -= 1) if ((this.raw[r - 1] || []).some((v) => v !== '' && v != null)) return r;
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.raw.map((line) => line.length)); }
  getMaxRows() { return Math.max(1000, this.raw.length); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  appendRow(values) { const row = this.getLastRow() + 1; values.forEach((v, i) => this.write(row, i + 1, v)); return this; }
  deleteRow(row) { this.raw.splice(row - 1, 1); return this; }
  clear() { this.raw = []; return this; }
  getFilter() { return this.filter; }
  getActiveRange() { return { getRow: () => this.activeRow }; }
  activate() { this.spreadsheet.active = this; return this; }
  /** Test helper: the row as an object keyed by the header row. */
  rowObject(row) {
    const headers = this.raw[0] || [];
    const object = {};
    headers.forEach((h, i) => { object[h] = this.cell(row, i + 1); });
    return object;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.id = newId('ss_');
    this.sheets = [new FakeSheet(this, 'Sheet1')];
    this.active = this.sheets[0];
  }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  insertSheet(name, index = this.sheets.length) { const sheet = new FakeSheet(this, name); this.sheets.splice(index, 0, sheet); return sheet; }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); }
}

// ---------------------------------------------------------------- Drive and Docs

function createDrive(docs) {
  const items = new Map();
  const make = (kind, name, parent, fixedId) => {
    const id = fixedId || newId(kind === 'folder' ? 'fo_' : 'fi_');
    const item = {
      kind, name, parent, trashed: false,
      getId: () => id,
      getName: () => item.name,
      getUrl: () => `https://drive.google.com/${kind === 'folder' ? 'drive/folders' : 'file/d'}/${id}`,
      isTrashed: () => item.trashed,
      getParents: () => iterator(item.parent ? [item.parent] : []),
      moveTo: (folder) => { item.parent = folder; return item; },
      getFoldersByName: (n) => iterator([...items.values()].filter((i) => i.kind === 'folder' && i.parent === item && i.name === n)),
      getFilesByName: (n) => iterator([...items.values()].filter((i) => i.kind === 'file' && i.parent === item && i.name === n && !i.trashed)),
      createFolder: (n) => make('folder', n, item),
      makeCopy: (n, folder) => {
        const copy = make('file', n, folder);
        const source = docs.get(id);
        if (source) docs.set(copy.getId(), source.clone(copy.getId(), n));
        return copy;
      },
    };
    items.set(id, item);
    return item;
  };
  const root = make('folder', 'My Drive', null);
  return {
    items,
    register: (id, name) => make('file', name, root, id),
    DriveApp: {
      getFileById: (id) => { const f = items.get(id); if (!f) throw new Error(`No file ${id}`); return f; },
      getFolderById: (id) => items.get(id),
      getFoldersByName: (n) => iterator([...items.values()].filter((i) => i.kind === 'folder' && i.name === n)),
      createFolder: (n) => make('folder', n, root),
    },
  };
}

class FakeDoc {
  constructor(id, name, blocks = []) {
    this.id = id;
    this.name = name;
    this.blocks = blocks; // text of every paragraph, list item and table cell, in order
    const doc = this;
    this.body = chainable({
      clear() { doc.blocks = []; return doc.body; },
      appendParagraph(text) { doc.blocks.push(String(text)); return chainable({ editAsText: () => chainable({}) }); },
      appendListItem(text) { doc.blocks.push(String(text)); return chainable({}); },
      appendTable(cells) { cells.forEach((row) => row.forEach((c) => doc.blocks.push(String(c)))); return chainable({}); },
      replaceText(pattern, replacement) {
        const re = new RegExp(pattern, 'g');
        doc.blocks = doc.blocks.map((b) => b.replace(re, () => replacement));
        return doc.body;
      },
    });
  }
  getId() { return this.id; }
  getBody() { return this.body; }
  getHeader() { return null; }
  getFooter() { return null; }
  saveAndClose() {}
  text() { return this.blocks.join('\n'); }
  clone(id, name) { return new FakeDoc(id, name, this.blocks.slice()); }
}

// ---------------------------------------------------------------- Everything together

/**
 * Loads dist/apps-script/Code.gs into a fresh sandbox with fake Google services.
 * Returns the sandbox (the script's global functions) plus handles for assertions.
 */
function loadAppsScript({ ownerEmail = 'owner@example.com', code = fs.readFileSync(CODE_PATH, 'utf8') } = {}) {
  const spreadsheet = new FakeSpreadsheet();
  const docs = new Map();
  const drive = createDrive(docs);
  drive.register(spreadsheet.getId(), 'PureLine Leads (test)');
  const cache = new Map();
  const properties = new Map();
  const sent = [];
  const drafts = [];
  const alerts = [];
  const triggers = [];
  const enumProxy = new Proxy({}, { get: (t, p) => String(p) });

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getActiveSheet: () => spreadsheet.active,
      newDataValidation: () => chainable({ build: () => ({}) }),
      newConditionalFormatRule: () => chainable({ build: () => ({}) }),
      getUi: () => chainable({ alert: (...args) => { alerts.push(args); }, ButtonSet: { OK: 'OK' } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
      }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => [...crypto.createHash('sha256').update(String(text), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      computeHmacSha256Signature: (text, secret) => [...crypto.createHmac('sha256', secret).update(text).digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (date) => date.toISOString().slice(0, 10),
    },
    MailApp: { sendEmail: (message) => { sent.push(message); }, getRemainingDailyQuota: () => 100 },
    GmailApp: { createDraft: (to, subject, body, options) => { drafts.push({ to, subject, body, options }); }, getAliases: () => [] },
    Session: { getEffectiveUser: () => ({ getEmail: () => ownerEmail }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({ content, setMimeType() { return this; }, getContent() { return content; } }),
    },
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ success: false }) }) },
    ScriptApp: {
      getScriptId: () => 'script-123',
      getProjectTriggers: () => triggers.map((name) => ({ getHandlerFunction: () => name })),
      newTrigger: (name) => chainable({ create: () => { triggers.push(name); } }),
    },
    DriveApp: drive.DriveApp,
    DocumentApp: {
      ParagraphHeading: enumProxy,
      GlyphType: enumProxy,
      create: (name) => {
        const id = newId('doc_');
        const doc = new FakeDoc(id, name);
        docs.set(id, doc);
        drive.register(id, name);
        return doc;
      },
      openById: (id) => docs.get(id),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  /** Calls doPost like the web app would and returns the parsed JSON reply. */
  const post = (body) => JSON.parse(sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent());

  return { gas: sandbox, post, spreadsheet, docs, drive, cache, properties, sent, drafts, alerts, triggers };
}

module.exports = { loadAppsScript, CODE_PATH };
