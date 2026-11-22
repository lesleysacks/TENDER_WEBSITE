# Deploying the website with a working enquiry backend

## Why the current Vercel site cannot save enquiries

`https://pureline-sable.vercel.app` serves the HTML, CSS and JavaScript files only. "Save and continue" and
"Submit My Enquiry" call `/api/leads`, which is answered by the Node server (`npm start`, `server/index.js`).
Vercel does not run that server, so every enquiry fails there with "We could not save your enquiry right now".

The server also stores leads in a file (`LEADS_FILE`). The host therefore needs:

1. a long-running Node.js 20+ process (not serverless functions), and
2. a **persistent disk**, so leads survive restarts and redeploys.

Both options below meet these requirements. One process serves the pages and the API on the same domain,
so no cross-origin set-up is needed.

| | Option A: Render (recommended to start) | Option B: VPS + Cloudflare Tunnel |
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
