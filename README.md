# PureLine Hygiene website

Landing page, full FAQ page, tender supply estimator and two-stage lead capture for PureLine Hygiene.
Plain HTML/CSS/JavaScript in the browser and a small Node.js server with **no third-party dependencies**.

## Run it

Requires Node.js 20 or later.

```bash
npm start          # http://127.0.0.1:8000
npm test           # unit + API tests
npm run test:e2e   # headless Chrome/Edge journey test + screenshots in tests/e2e/output/
```

The site can no longer be hosted as static files only: lead capture needs the Node server
(any host that runs Node, behind HTTPS, with a persistent disk). A static host such as Vercel shows the
pages but cannot save enquiries. **See [docs/DEPLOY.md](docs/DEPLOY.md)** (Render Blueprint in `render.yaml`,
or a VPS with `deploy/pureline.service` + Cloudflare Tunnel).

## Structure

| Path | Purpose |
|---|---|
| `index.html` | Landing page: hero (over the logistics image), credentials, estimator + enquiry |
| `faq.html` | Full FAQ page (categorised), including the privacy notice (`#privacy`) |
| `css/styles.css` | All styles |
| `shared/pricing.js` | **Pricing configuration** — used by both the browser and the server |
| `shared/quantity.js` | Quantity bounds, parsing, slider curve, +/- steps |
| `shared/lead-schema.js` | Lead statuses, qualifying options, validation (browser + server) |
| `js/site-config.js` | Business settings: official email/WhatsApp, photography paths, verified coverage |
| `js/estimator.js` | Quantity controls, visualiser, gallery, cost estimate (one shared quantity) |
| `js/lead-funnel.js` | Progress indicator, Stage 1 draft save, Stage 2 submission, confirmation |
| `js/visual-tiers.js`, `js/illustrations.js` | Supply-volume tiers and drawn stand-ins for photography |
| `js/site.js` | Mobile navigation, hero background image |
| `server/` | HTTP server, lead service, file store, rate limiting, integrations, staff CLI |
| `docs/ASSET-REGISTER.md` | Internal asset attribution and permissions register |
| `docs/DEPLOY.md`, `render.yaml`, `deploy/` | Hosting guide, Render Blueprint, systemd unit |
| `tests/` | `node:test` suites and the browser end-to-end test |

## Pricing

Only the **R0.30 per pad** starting price is confirmed. `shared/pricing.js` defines five bulk tiers that are
**placeholders awaiting management approval** — all currently use R0.30, so no discount is advertised.
To approve a tier, change its `unitPriceCents` and set `approved: true`. The server recalculates every price;
values sent by the browser are ignored.

The estimator asks **how many** (type single pads or packs of 10, `PACK_SIZE`; the two boxes stay in sync) and
**how much you want to pay** (per pad or per pack of 10). It shows "You asked for 1,200 packs = R3,600.00",
the base price for that quantity at the chosen price (quantity × chosen price). The chosen-price range
(`TARGET_PRICE`, currently R0.10–R3.00, default R0.30) is a placeholder awaiting approval. The chosen price is saved
with the enquiry (`targetUnitPriceCents`, `targetPackPriceCents`, `targetTotalCents`) alongside our indicative price.

## Lead lifecycle

1. **Stage 1 (50%)** — quantity, chosen price, stickers/decals, delivery (or collection), the optional delivery
   point and the qualifying answer ("Which describes you?", asked in the hero) are saved via `POST /api/leads`.
   The server generates a random reference (`PLH-` + 8 hex characters from the OS CSPRNG), recalculates
   the estimate and stores the lead as `DRAFT` with a creation timestamp and a snapshot of the original draft.
   The browser receives a random edit token (stored only as a hash) so only it can update that draft.
2. While the draft is open, changes sync with `PATCH /api/leads/:ref`; a refresh restores it (`GET`).
3. **Stage 2 (100%)** — `POST /api/leads/:ref/submit` validates the contact details, attaches them, sets
   `SUBMITTED` and the submission timestamp, and keeps the original draft snapshot. Repeat submissions return
   the same confirmation without creating or notifying twice. Progress shows 100% only after this succeeds.

Statuses: `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `CONTACTED`, `QUOTED`, `WON`, `LOST`.

## Spam and abuse protection

Built in (always on):
- **Rate limits per visitor:** 10 drafts, 10 submissions and 120 updates per 10 minutes.
- **Global caps** across all visitors: 300 drafts and 150 submissions per hour, to stop a spam wave spread over many addresses.
- **Request hygiene:** a hidden honeypot field, a same-origin check, an 8 KB body limit and strict validation.
- **Integrity:** server-side price recalculation, idempotent submissions and automatic draft clean-up.
- **Headers and files:** Content-Security-Policy and other security headers. Only public folders are served (`data/`, `server/`, `tests/` and `docs/` are not).

Optional bot check (**Cloudflare Turnstile**, free, no puzzles for most people): create a widget at
dash.cloudflare.com → Turnstile, then set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The widget then
appears above "Submit My Enquiry", and the server refuses submissions without a valid token.

### Recommended hosting: Cloudflare in front of the server

1. **Cloudflare Tunnel** (`cloudflared`) publishes the site without opening any ports or exposing your server's IP:
   `cloudflared tunnel create pureline` → route your domain to `http://localhost:8000`.
2. Start the server with `NODE_ENV=production TRUST_PROXY=cloudflare npm start`. `TRUST_PROXY=cloudflare` is
   essential behind the tunnel: it reads the real visitor IP from `CF-Connecting-IP`. Otherwise every visitor
   shares one rate-limit bucket.
3. In the Cloudflare dashboard, turn on **Bot Fight Mode** and the **managed WAF rules**, and add a **rate-limiting rule**
   for `/api/leads*`, for example 20 requests per minute per IP, then block.
4. Add the Turnstile keys from the section above.
5. Scan before launch: run an OWASP ZAP baseline scan against the public URL, and check Cloudflare
   Security → Events after go-live.

### Local development

Run `npm start`, then open `http://127.0.0.1:8000`. If you prefer VS Code Live Server (port 5500), keep
`npm start` running too. The page sends enquiries to port 8000 automatically. `.vscode/settings.json` stops
Live Server from reloading the page when lead data is saved.

### Staff review (no web admin; run on the server)

```bash
npm run leads -- list SUBMITTED
npm run leads -- show PLH-8F3A92C7
npm run leads -- status PLH-8F3A92C7 UNDER_REVIEW
npm run leads -- export leads.csv     # Google Sheets column order
npm run leads -- delete PLH-8F3A92C7  # POPIA deletion request
```

## Privacy (POPIA)

- Collected: requirements, name, optional company, town/city, email, optional phone. No date of birth or ID number, and no login.
- References are random, never derived from personal data. Lead data is stored in `data/leads.json`,
  which is git-ignored and never served. Set `LEADS_FILE` to a location outside the web root in production.
- Unsubmitted drafts are deleted after `DRAFT_RETENTION_DAYS` (default 30).
- Consent: privacy consent is required to submit, and WhatsApp follow-up is a separate opt-in.

## Future integrations (not live)

Website → backend → Google Apps Script → Google Sheets lead register → business email / WhatsApp.

- `server/integrations/index.js` builds the lead-register row (Lead ID … Status), the internal
  notification, the customer acknowledgement and the WhatsApp link with the reference prefilled.
- Set `APPS_SCRIPT_WEBHOOK_URL` and `APPS_SCRIPT_SHARED_SECRET` to send HMAC-signed rows to the Sheet.
  `server/integrations/google-apps-script/LeadRegister.gs` is the Apps Script template (upsert by Lead ID).
- Email and automated WhatsApp messages need the official business accounts and an approved WhatsApp Business
  integration. Until then the server logs that they are not configured.
- Detailed Google Forms are sent manually after internal review, not to every visitor.

## Environment variables

`PORT` (8000), `HOST` (127.0.0.1), `LEADS_FILE`, `TRUST_PROXY` (`cloudflare` or `true`), `ALLOWED_ORIGINS`, `NODE_ENV`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`DRAFT_RETENTION_DAYS`, `APPS_SCRIPT_WEBHOOK_URL`, `APPS_SCRIPT_SHARED_SECRET`.
