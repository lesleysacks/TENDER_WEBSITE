'use strict';

/*
 * Builds dist/apps-script/Code.gs: the single file to paste into Google Apps Script.
 * It joins the shared rules (pricing, validation, row layout, email texts) with the backend, so the
 * website, the Node server and the Apps Script never drift apart.
 *
 *   npm run build:apps-script            write the file
 *   node scripts/build-apps-script.js --check   fail if the committed file is out of date (used by tests)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['shared/pricing.js', 'shared/lead-schema.js', 'shared/lead-messages.js', 'apps-script/Backend.js'];
const OUTPUT = path.join(ROOT, 'dist', 'apps-script', 'Code.gs');

function build() {
  const parts = SOURCES.map((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '').trimEnd();
    return `// ===== ${file} =====\n${source}\n`;
  });
  return [
    '/**',
    ' * PureLine Hygiene – enquiries backend for Google Apps Script.',
    ' * GENERATED FILE – do not edit. Built from the website repository with `npm run build:apps-script`.',
    ' *',
    ' * Install: open the Google Sheet → Extensions → Apps Script → replace Code.gs with this file → Save →',
    ' * run `setup` once (approve the permissions) → Deploy → New deployment → Web app,',
    ' * Execute as: Me, Who has access: Anyone → copy the /exec URL into the website (js/site-config.js).',
    ' */',
    '',
    ...parts,
  ].join('\n');
}

const output = build();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (current !== output) {
    console.error('dist/apps-script/Code.gs is out of date. Run: npm run build:apps-script');
    process.exit(1);
  }
  console.log('dist/apps-script/Code.gs is up to date.');
} else {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, output);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${output.length.toLocaleString('en-ZA')} characters)`);
}

module.exports = { build, OUTPUT };
