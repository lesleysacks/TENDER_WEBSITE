'use strict';

/*
 * Entry point: `npm start`. Serves the website and the lead API from one process.
 *
 * Environment variables (all optional):
 *   PORT                       default 8000
 *   HOST                       default 127.0.0.1 (set 0.0.0.0 behind a reverse proxy)
 *   LEADS_FILE                 default data/leads.json (keep outside any public web root)
 *   TRUST_PROXY                "cloudflare" behind Cloudflare / Cloudflare Tunnel (uses CF-Connecting-IP),
 *                              "true" behind another proxy that sets X-Forwarded-For
 *   TURNSTILE_SITE_KEY         Cloudflare Turnstile site key (public) — enables the bot check
 *   TURNSTILE_SECRET_KEY       Cloudflare Turnstile secret key (server-side only)
 *   ALLOWED_ORIGINS            comma-separated extra origins allowed to call the API
 *   NODE_ENV                   "production" disables the VS Code Live Server origins (ports 5500/5501)
 *   DRAFT_RETENTION_DAYS       unsubmitted drafts are deleted after this many days (default 30)
 *   APPS_SCRIPT_WEBHOOK_URL    future Google Apps Script lead register endpoint
 *   APPS_SCRIPT_SHARED_SECRET  HMAC secret shared with that Apps Script (server-side only)
 */

const path = require('node:path');
const { createApp } = require('./app');
const { FileLeadStore } = require('./lead-store');
const { createLeadService } = require('./lead-service');
const { createNotifier } = require('./integrations');
const { createTurnstile } = require('./turnstile');

const rootDir = path.resolve(__dirname, '..');
const env = process.env;
const DAY_MS = 24 * 60 * 60 * 1000;

// Outside production, also accept VS Code Live Server so the page works when opened from the editor.
const LIVE_SERVER_ORIGINS = ['http://127.0.0.1:5500', 'http://localhost:5500', 'http://127.0.0.1:5501', 'http://localhost:5501'];
function allowedOrigins() {
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  return env.NODE_ENV === 'production' ? configured : [...configured, ...LIVE_SERVER_ORIGINS];
}

async function main() {
  const store = await new FileLeadStore(env.LEADS_FILE || path.join(rootDir, 'data', 'leads.json')).init();
  const notifier = createNotifier({ env });
  const leadService = createLeadService({ store, notifier });

  const retentionDays = Number(env.DRAFT_RETENTION_DAYS || 30);
  const purge = async () => {
    const removed = await store.purgeDrafts(retentionDays * DAY_MS);
    if (removed) console.log(`[leads] removed ${removed} expired draft(s)`);
  };
  await purge();
  setInterval(() => purge().catch((error) => console.error('[leads] purge failed', error)), DAY_MS / 2).unref();

  const turnstile = createTurnstile({ siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY });

  const server = createApp({
    rootDir,
    leadService,
    turnstile,
    trustProxy: env.TRUST_PROXY === 'cloudflare' ? 'cloudflare' : env.TRUST_PROXY === 'true',
    allowedOrigins: allowedOrigins(),
  });

  const port = Number(env.PORT || 8000);
  const host = env.HOST || '127.0.0.1';
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use — the website is probably already running at http://${host}:${port}.\n` +
          `Use that one, stop the other process first, or start on another port (PowerShell: $env:PORT=8001; npm start).`
      );
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, host, () => {
    const integrations = notifier.status();
    console.log(`PureLine Hygiene website running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(
      `Integrations — Google Sheets: ${integrations.googleSheets ? 'on' : 'not configured'}, ` +
        `email: not configured, WhatsApp: not configured`
    );
    console.log(`Spam protection — rate limits: on, Turnstile: ${turnstile.enabled ? 'on' : 'off (set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY)'}, proxy IPs: ${env.TRUST_PROXY || 'not trusted'}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
