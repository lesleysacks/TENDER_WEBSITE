# Deploying the website with a working enquiry backend

## Recommended: Vercel + Google Apps Script (free)

The website stays on Vercel. Enquiries go straight from the page to a **Google Apps Script web app**
attached to a Google Sheet in your Google Drive. The script:

- saves each draft and submitted enquiry as a row in the **Leads** tab, with every calculator answer;
- emails the team (the *Notification email* on the Settings tab) and sends the customer an acknowledgement;
- adds a **PureLine** menu to the Sheet: *Create quotation for selected lead* (fills the quotation template
  and saves it in `Quotes/`) and *Draft email reply* (creates a Gmail draft from 7 templates; nothing is
  sent automatically);
- deletes drafts nobody submitted after 30 days.

The script is **`dist/apps-script/Code.gs`**, built from `apps-script/Backend.js` plus the shared pricing and
validation rules (`npm run build:apps-script`). The tests check that it is up to date.

### Install (about 10 minutes)

Use the Google account that should own the leads. While testing that is your personal account; later
it is the business account. The account needs free Google storage: Sheets and Docs count towards the
15 GB, and a full account also stops receiving email.

1. In Google Drive create a Google Sheet (any name, e.g. *PureLine Leads*), then open
   **Extensions → Apps Script**.
2. Delete the sample code, paste the whole of `dist/apps-script/Code.gs`, and click **Save**.
3. In the function list choose **`setup`** and click **Run**. Approve the permissions (Sheets, Drive,
   Docs, Gmail and email sending). Setup builds:
   - a **PureLine Hygiene** folder with the Sheet in it, plus `Templates/` (Quotation template, Email reply
     templates), `Quotes/` and a **START HERE – admin links** document;
   - the Sheet tabs: **Dashboard** (quick links, counts, totals, latest enquiries and 6 charts: status,
     customer type, enquiries and pads per month, delivery vs collection, stickers vs plain packs),
     **Leads**, **Settings**, **How to use** and **Chart data** (the live formulas the charts read).
4. On the **Settings** tab, check the *Notification email* and fill in the company and bank details for
   quotations.
5. **Deploy → New deployment →** type **Web app**. Set *Execute as*: **Me**, *Who has access*: **Anyone**.
   Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).
6. Put that URL in `js/site-config.js` as `leadsEndpoint`, commit and push. Vercel redeploys the preview.
7. Run the test checklist in the START HERE document. Then merge to `main`.

**Changing the script later:** paste the new `Code.gs`, then use **Deploy → Manage deployments → Edit
(pencil) → Version: New version → Deploy**. That keeps the same `/exec` URL.

**Moving to the business account:** repeat the install signed in as that account and replace
`leadsEndpoint` with its new URL. Alternatively, keep the test deployment and change *Notification
email* on the Settings tab.

### Limits and safety

- Each save takes 1–3 seconds. The page shows "Saving your changes…" while it waits.
- A free Gmail account can send about **100 emails a day**, and each enquiry sends 2, so the limit is
  roughly 50 enquiries a day. A Google Workspace account allows far more.
- Spam protection:
  - a hidden honeypot field;
  - site-wide caps of 300 drafts and 150 submissions per hour;
  - prices recalculated on the server;
  - random references, and edit tokens stored only as hashes.

  Apps Script can't see visitor IP addresses, so there are no per-visitor limits. If spam becomes a problem,
  add Cloudflare Turnstile: put the site key on the Settings tab and the secret in **Project Settings →
  Script properties** as `TURNSTILE_SECRET`.
- `vercel.json` sends the security headers: a CSP that allows only this site and `script.google.com`.
  `.vercelignore` keeps `server/`, `tests/`, `docs/`, `apps-script/` and `dist/` out of the public site.

### Try it locally without Google

```bash
npm run build:apps-script
node tests/support/apps-script-standin.js 8124
```

Then set `leadsEndpoint: 'http://127.0.0.1:8124/exec'` in `js/site-config.js`, run `npm start`, and the
page saves to an in-memory stand-in of the Sheet. Revert `leadsEndpoint` before committing.

---

# Alternative: run the Node server

The Node server (`npm start`) serves the pages and its own `/api/leads` and stores leads in a file.
Choose this instead of Apps Script if you need per-visitor rate limits or faster saves. It needs:

1. a long-running Node.js 20+ process (not serverless functions), and
2. a **persistent disk**, so leads survive restarts and redeploys.

Leave `leadsEndpoint` empty in `js/site-config.js` so the page uses the server's `/api`.

| | Option A: Render | Option B: VPS + Cloudflare Tunnel |
|---|---|---|
| Effort | Low: connect GitHub, click deploy | Medium: basic Linux admin |
| Deploys | Automatic on every push to the main branch | `git pull` + restart (or a script) |
| Cost (approx.) | Starter instance ~US$7/month + disk ~US$0.25/GB/month | VPS from ~US$5/month; Cloudflare free plan |
| Visitor IP for rate limits | From `X-Forwarded-For` (good, see note) | From Cloudflare, cannot be spoofed (best) |
| Backups | Render takes automatic disk snapshots (check retention in the dashboard) | You set up a cron copy (below) |

Check current prices before you sign up; they change.

---

## Option A: Render

The repository includes a Blueprint (`render.yaml`) with the full configuration.

1. **Merge the branch** with these changes into the branch Render will deploy (usually `main`).
2. Sign in at dashboard.render.com with the GitHub account that owns the repository.
3. **New → Blueprint**, pick this repository. Render reads `render.yaml` and proposes one web service,
   `pureline-website`, on the **Starter** plan with a 1 GB disk mounted at `/var/data`.
4. Leave `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` empty for now (optional bot check), then **Apply**.
5. Wait for the deploy, open the `…onrender.com` address and run the checks under
   [After any deployment](#after-any-deployment).
6. **Custom domain:** in the service → Settings → Custom Domains, add your domain (for example
   `www.yourdomain.co.za`) and create the DNS record Render shows at your domain registrar. Render issues
   the HTTPS certificate automatically.
7. **Retire the Vercel site** once the new address works: remove the domain from Vercel (or delete the
   Vercel project), so customers never land on the copy whose enquiry form cannot save.

What `render.yaml` sets, and why:

| Setting | Value | Reason |
|---|---|---|
| `HOST` | `0.0.0.0` | The server defaults to `127.0.0.1`, which Render cannot reach |
| `PORT` | set by Render | The server already reads `PORT` |
| `NODE_ENV` | `production` | Turns off the local VS Code Live Server origins |
| `TRUST_PROXY` | `true` | Rate limits use the visitor address from Render's proxy |
| `LEADS_FILE` | `/var/data/leads.json` | Lives on the persistent disk, outside the website files |
| `healthCheckPath` | `/api/health` | Render restarts the service if this stops answering |

**Staff lead review on Render:** open the service → **Shell**, then run the usual commands, for example
`npm run leads -- list SUBMITTED` or `npm run leads -- export /var/data/leads.csv`.

Notes:
- The persistent disk means Render runs **one instance** and briefly stops the old one during each deploy
  (a few seconds of downtime). That suits the single-process file store and rate limiter.
- Data region: `render.yaml` uses Frankfurt (EU). POPIA allows transfers to countries with comparable
  protection such as the EU, but mention the hosting location in the privacy notice.
- On `TRUST_PROXY=true` the server uses the first `X-Forwarded-For` address. A determined attacker can
  fake that header to get around the *per-visitor* limits; the *global* caps (300 drafts / 150 submissions
  per hour) still apply. For stronger protection, switch on Turnstile (below) or use Option B.

---

## Option B: Linux VPS + Cloudflare Tunnel

This is the set-up the server was originally built and tested for (see README → "Recommended hosting").
The server listens only on `127.0.0.1`; `cloudflared` carries traffic in from Cloudflare, so no ports are
opened and visitor addresses come from `CF-Connecting-IP`, which visitors cannot fake.

Prerequisites: an Ubuntu 22.04/24.04 VPS, and your domain's DNS managed by Cloudflare (free plan).

```bash
# 1. Node.js 22 and a service user
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo useradd --system --home /opt/pureline --shell /usr/sbin/nologin pureline
sudo mkdir -p /var/lib/pureline && sudo chown pureline: /var/lib/pureline && sudo chmod 700 /var/lib/pureline

# 2. The code
sudo git clone https://github.com/lesleysacks/tender_website.git /opt/pureline
sudo chown -R pureline: /opt/pureline

# 3. Run it as a service (unit file is in this repo)
sudo cp /opt/pureline/deploy/pureline.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pureline
curl -s http://127.0.0.1:8000/api/health        # → {"ok":true}

# 4. Publish it through Cloudflare Tunnel (follow Cloudflare's install steps for cloudflared first)
cloudflared tunnel login
cloudflared tunnel create pureline
cloudflared tunnel route dns pureline www.yourdomain.co.za
#    then point the tunnel's ingress at http://localhost:8000 and install it as a service:
sudo cloudflared service install
```

Then, in the Cloudflare dashboard: turn on **Bot Fight Mode** and the **managed WAF rules**, and add a
rate-limiting rule for `/api/leads*` (for example 20 requests per minute per IP, then block).

**Updates:** `cd /opt/pureline && sudo -u pureline git pull && sudo systemctl restart pureline`

**Backups** (leads are personal information: keep backups private and encrypted where possible):

```bash
# /etc/cron.d/pureline-backup: daily copy, keep 30 days
15 2 * * * root cp /var/lib/pureline/leads.json /var/lib/pureline/backup-$(date +\%F).json && find /var/lib/pureline -name 'backup-*.json' -mtime +30 -delete
```

**Staff lead review:** `cd /opt/pureline && sudo -u pureline LEADS_FILE=/var/lib/pureline/leads.json npm run leads -- list SUBMITTED`

---

## Lead register and enquiry emails (either option)

New enquiries are emailed to **Nextgeneration.ai7.0@gmail.com** (`BUSINESS_EMAIL`), and each customer gets an acknowledgement.
Both are sent by the Google Apps Script from the Gmail account that owns it, so no email password is
stored on the server.

1. Sign in to Google as **Nextgeneration.ai7.0@gmail.com**. Create a Google Sheet with a tab named `Leads`.
2. Extensions → Apps Script. Paste `dist/apps-script/Code.gs`, then run `setup` once.
3. Project Settings → Script properties: add `SHARED_SECRET` with a long random value
   (for example the output of `openssl rand -hex 32`).
4. Deploy → New deployment → Web app, execute as **Me**, access **Anyone**. Approve the permissions
   (Sheets and "send email as you").
5. On the server set `APPS_SCRIPT_WEBHOOK_URL` to the deployment URL and `APPS_SCRIPT_SHARED_SECRET`
   to the same secret (Render: service → Environment; VPS: `/etc/pureline.env`), then restart.
6. The start-up log shows `email to Nextgeneration.ai7.0@gmail.com: on (via Apps Script)`. Submit a test enquiry: a row
   appears in the sheet and both emails arrive.

Consumer Gmail sends to about 100 recipients a day, which is roughly 50 enquiries. A Google Workspace
account raises that limit.

## Optional: Cloudflare Turnstile bot check (either option)

1. dash.cloudflare.com → Turnstile → Add widget, add your domain, mode **Managed**.
2. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Render: service → Environment;
   VPS: `/etc/pureline.env`, then `sudo systemctl restart pureline`).
3. The check appears above "Submit My Enquiry", and the server refuses submissions without it.

## After any deployment

Run these on the live address:

1. `https://<your-domain>/api/health` returns `{"ok":true}`.
2. Complete one enquiry end to end: choose "Which describes you?", set a quantity, enter a delivery point,
   **Save and continue** (progress shows 50%), add contact details, **Submit** (green confirmation with a
   `PLH-…` reference).
3. Refresh during step 2 of a second test enquiry: the draft is restored.
4. Find the test lead with the staff command (`npm run leads -- list SUBMITTED`) and delete it
   (`npm run leads -- delete PLH-…`).
5. Redeploy or restart, then list again: earlier leads are still there (the disk is persistent).
6. `https://<your-domain>/data/leads.json` returns **404**.

## Before going live (from the site audit)

- Replace `tenfoldtender.co.za` in `robots.txt` and `sitemap.xml` with the real domain, and add `faq.html`.
- Delete the unused legacy files that are still publicly served: `assets/icons/badge-*.svg`,
  `assets/images/og-preview.jpg`, `assets/images/hero-factory.webp`.
- Add business contact details, and the POPIA responsible-party / Information Officer details to the
  privacy notice.
