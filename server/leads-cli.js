'use strict';

/*
 * Internal lead review tool (staff only — runs on the server, never exposed over HTTP).
 *
 *   npm run leads -- list [STATUS]          list leads, optionally filtered by status
 *   npm run leads -- show PLH-XXXXXXXX       full record for one lead
 *   npm run leads -- status PLH-XXXXXXXX UNDER_REVIEW
 *   npm run leads -- export leads.csv        lead register as CSV (Google Sheets column order)
 *   npm run leads -- delete PLH-XXXXXXXX     delete a lead (POPIA deletion requests)
 */

const fs = require('node:fs');
const path = require('node:path');
const { FileLeadStore } = require('./lead-store');
const { LEAD_STATUSES } = require('../shared/lead-schema');
const { toLeadRegisterRow, REGISTER_COLUMNS } = require('./integrations');

const leadsFile = process.env.LEADS_FILE || path.join(__dirname, '..', 'data', 'leads.json');

const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop spreadsheet formula injection
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const store = await new FileLeadStore(leadsFile).init();
  const leads = store.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  switch (command) {
    case 'list': {
      const status = args[0]?.toUpperCase();
      const rows = leads
        .filter((lead) => !status || lead.status === status)
        .map((lead) => {
          const row = toLeadRegisterRow(lead);
          return { 'Lead ID': row['Lead ID'], Created: row.Created, Status: row.Status, Name: row.Name, Pads: row['Quantity (pads)'], 'Customer total': row['Customer total'], 'Lead Type': row['Lead Type'] };
        });
      console.table(rows);
      break;
    }
    case 'show': {
      const lead = store.get(args[0]);
      if (!lead) throw new Error(`No lead ${args[0]}`);
      delete lead.editTokenHash;
      console.log(JSON.stringify(lead, null, 2));
      break;
    }
    case 'status': {
      const [reference, next] = args;
      const status = String(next || '').toUpperCase();
      if (!LEAD_STATUSES.includes(status)) throw new Error(`Status must be one of ${LEAD_STATUSES.join(', ')}`);
      const updated = await store.update(reference, (lead) => {
        const at = new Date().toISOString();
        lead.status = status;
        lead.updatedAt = at;
        lead.history.push({ at, event: 'STATUS_CHANGED', status, by: 'staff' });
      });
      if (!updated) throw new Error(`No lead ${reference}`);
      console.log(`${reference} is now ${status}`);
      break;
    }
    case 'export': {
      const output = args[0] || 'leads.csv';
      const rows = leads.map(toLeadRegisterRow);
      const headers = REGISTER_COLUMNS;
      const csv = [headers, ...rows.map((row) => headers.map((h) => row[h]))]
        .map((line) => line.map(csvCell).join(','))
        .join('\n');
      fs.writeFileSync(output, csv, { encoding: 'utf8', mode: 0o600 });
      console.log(`Exported ${rows.length} lead(s) to ${output}`);
      break;
    }
    case 'delete': {
      if (!(await store.delete(args[0]))) throw new Error(`No lead ${args[0]}`);
      console.log(`Deleted ${args[0]}`);
      break;
    }
    default:
      console.log('Usage: npm run leads -- <list [STATUS] | show REF | status REF STATUS | export FILE | delete REF>');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
