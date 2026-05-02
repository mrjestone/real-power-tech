# Real Power Tech – Final Go‑Live Checklist (Step‑by‑Step)

Purpose: A guided, test‑driven runbook to complete the remaining work and launch the MVP. Each step has clear actions and tests. Check items off as you complete them.

Legend:

- [ ] To do
- [x] Done

Prerequisites

- [ ] Production/staging Vercel project is created and the app deploys successfully
- [ ] MongoDB Atlas database is provisioned and accessible from Vercel and the RADIUS host
- [ ] ClickPesa credentials available (Client ID, API Key, Checksum Key), Hosted Checkout enabled
- [ ] A MikroTik hAP ax² router on-site with Hotspot enabled (per deviceSetuReport.md)
- [ ] A Linux VM for FreeRADIUS with a static public IP (e.g., Fly.io/DigitalOcean)

Environment variables (Vercel)

- [ ] MONGODB_URI, MONGODB_DB
- [ ] CLICKPESA_BASE_URL (default ok), CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY, CLICKPESA_CHECKSUM_KEY
- [ ] CLICKPESA_CURRENCY (e.g., TZS)
- [ ] RADIUS_WRITE_ENABLED="true" (only enable after RADIUS setup is live)

Step 1 — Add the Success page and return flow (App)
Actions

- [x] Create `app/success/page.js` that:
  - Reads `orderReference` from the URL
  - Calls `GET /api/v1/portal/transactions/{orderReference}`
  - Shows status and package details; if `Pending`, auto‑poll every 2–3s until `Completed` or `Failed`
  - Shows “You are connected!” when completed
- [x] In ClickPesa dashboard, set the hosted checkout Return URL to your domain: `https://<your-domain>/success?orderReference={{orderReference}}` (if placeholder unsupported, set `/success`)

Test

- [ ] Load `/success?orderReference=TEST123` manually; confirm page renders and polling calls the API cleanly

Step 2 — Webhook configuration (ClickPesa → App)
Actions

- [x] In ClickPesa dashboard, set Webhook URL to `https://<your-domain>/api/v1/webhooks/clickpesa` for both PAYMENT RECEIVED and PAYMENT FAILED
- [ ] Ensure `CLICKPESA_CHECKSUM_KEY` matches the key configured in ClickPesa

Test

- [ ] Use a small paid or sandbox transaction to confirm your app returns 200 and the Transaction status becomes `Completed`

Step 3 — RADIUS data model alignment
Recommendation (standard approach)

- Keep reply attributes (e.g., `Session-Timeout`) in `radreply`, and acceptance in `radcheck`.

Actions

- [ ] Choose one of:
  - Option A (recommended): Update the app to write `Session-Timeout` into a `radreply` collection and create a `radcheck` record for acceptance (e.g., `Auth-Type := Accept`) tied to the same username (normalized client MAC)
  - Option B (fallback): Configure FreeRADIUS to read reply attributes from your existing `radcheck` collection (non‑standard, not recommended long‑term)
- [ ] Add indexes on `username` and a TTL index on `expiresAt` for cleanup

Test

- [ ] Insert a test `username` (MAC) with a short `Session-Timeout=60` and confirm RADIUS replies it back on Access‑Accept (see Step 6 for an end‑to‑end test)

Step 4 — FreeRADIUS deployment and config
Actions

- [ ] Install FreeRADIUS and `rlm_mongodb`
- [ ] Configure MongoDB connection for `radcheck` and `radreply`
- [ ] Configure `clients.conf` to accept your MikroTik router(s) with a strong shared secret
- [ ] In sites‑enabled (authorize/authenticate), accept users present in MongoDB and reply with `Session-Timeout` (and optional `Mikrotik-Rate-Limit`)
- [ ] Enable accounting (1813) if you want session logs (optional)

Test

- [ ] From the MikroTik, run a test authentication using the client MAC as the username; confirm Access‑Accept and presence of `Session-Timeout`

Step 5 — MikroTik Hotspot and walled garden (pre‑auth allowlist)
Required pre‑auth domains

- Your portal domain (Vercel): `portal.<your-domain>` or your chosen hostname
- ClickPesa hosted checkout: `checkout.clickpesa.com`

Actions

- [ ] Enable RADIUS: `/ip hotspot profile set [your-profile] use-radius=yes`
- [ ] Enable MAC auth (passwordless experience): `/ip hotspot profile set [your-profile] login-by=mac,http-chap` and `/ip hotspot set [hotspot] addresses-per-mac=2`
- [ ] Walled garden allowlist:
  - [ ] Add your portal domain (and optional wildcard for assets if needed)
  - [ ] Add `checkout.clickpesa.com`
  - Note: If any payment assets load from other ClickPesa subdomains/CDNs, add them too after testing
- [ ] Customize `login.html` to immediately redirect to your portal:
  - `https://portal.<your-domain>/portal?mac=$(mac)&locationId=<ObjectId>`
  - Use the specific location’s MongoDB `_id` for `locationId` so the app links revenue to the right partner

Test

- [ ] Connect to the hotspot as a new client
- [ ] Confirm the browser is captured and redirected to your portal
- [ ] Confirm you can open `checkout.clickpesa.com` before payment (but general internet is still blocked)

Step 6 — End‑to‑end payment → access grant
Actions

- [ ] On the portal, select a package and trigger Hosted Checkout
- [ ] Complete a real/sandbox payment on ClickPesa
- [ ] Let the ClickPesa webhook hit your app; app updates Transaction to `Completed` and writes RADIUS records

Test

- [ ] After payment success, you land on `/success?orderReference=...`; status turns `Completed`
- [ ] The device gains internet access automatically (no password)
- [ ] Verify FreeRADIUS shows an Access‑Accept with `Session-Timeout` and MikroTik status shows the user logged in
- [ ] After the purchased time elapses, access is revoked automatically

Step 7 — Reporting and reconciliation
Actions

- [ ] Use Admin → Reports to generate a report for a partner and a date range
- [ ] Verify totals match ClickPesa statements for that period

Test

- [ ] Totals reconcile; operator/partner shares calculate correctly per configured %

Step 8 — Monitoring and alerts
Actions

- [ ] Add Sentry (frontend + API routes)
- [ ] Set uptime monitors: portal URL and RADIUS UDP 1812/1813
- [ ] Configure log shipping or alerts on webhook failures

Test

- [ ] Force a test error and confirm Sentry captures it
- [ ] Stop RADIUS briefly and confirm uptime alert fires (staging)

Step 9 — Go‑live checks

- [ ] DNS: `portal.<your-domain>` → Vercel; `radius.<your-domain>` → RADIUS VM IP
- [ ] Secrets rotated and stored only in Vercel/VM envs
- [ ] RADIUS client list contains all production routers
- [ ] Walled garden entries present on all routers
- [ ] Rollback plan prepared (disable use‑radius / remove redirect if needed)

Current rollback and test sequence:

1. Disable RADIUS on the hotspot profile if a live test fails.
2. Restore the hotspot login redirect page if the portal path is the issue.
3. Verify the router can still reach the local hotspot login page before retrying.
4. Re-run the hotspot login flow with a single test device and watch both router logs and the RADIUS service logs.
5. If the tunnel is the blocker, confirm WireGuard handshake status before touching app-side code.

Appendix — Notes and tips

- If you see HTTPS CNA issues on some devices, ensure the immediate redirect points to your HTTPS portal domain and the router serves only its internal login page briefly before redirecting.
- If the hosted checkout loads assets from additional subdomains (fonts, images, scripts), add them to the walled garden after observing network requests in the browser devtools.
- To improve UX, display the location name on the portal when `locationId` is present (optional polish).
