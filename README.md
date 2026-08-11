# Agbota Segun — Creator & Streamer Growth Strategies

A complete, production-ready full-stack website: premium storefront, real accounts,
real orders, real human-to-human chat (text, images, documents, voice), a payment
submission + confirmation workflow, an owner-only dashboard, and an owner-managed
Proof of Work gallery.

Everything important is stored in **persistent PostgreSQL** — accounts, orders,
messages, uploads, payment proof, reviews, notifications and Proof of Work all
survive refresh, logout, browser restart, server restart and Render redeployment.

---

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js 20 + Express |
| Database | PostgreSQL (`pg`, parameterized queries) |
| Realtime | Socket.IO (cookie-authenticated) |
| Auth | bcrypt hashing + JWT in an httpOnly cookie, sessions tracked in the DB |
| Uploads | Stored as `bytea` inside PostgreSQL (survives Render redeploys) |
| Frontend | Server-served HTML/CSS/JS, no build step required |

---

## Quick start (local)

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD, BTC_ADDRESS
npm start                   # migrates + seeds automatically, then serves on PORT
```

Migrations and idempotent seeding run automatically on every boot.
You can also run them manually:

```bash
npm run migrate   # create tables, indexes, constraints
npm run seed      # seed the 14 strategies + ensure the owner account
npm test          # full end-to-end suite (server must be running)
```

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | Render sets this | Server port (binds `0.0.0.0`) |
| `NODE_ENV` | yes | `production` on Render |
| `DATABASE_URL` | **yes** | Persistent PostgreSQL connection string |
| `JWT_SECRET` | **yes** | Long random string (≥32 chars) for signing sessions. **Must stay the same forever** — changing it logs everyone out. Generate with `openssl rand -hex 48` |
| `ADMIN_EMAIL` | yes | Owner account email (`agbotasegun.outreach@gmail.com`) |
| `ADMIN_PASSWORD` | yes (first boot) | Creates the owner account if it does not exist |
| `ADMIN_NAME` | optional | Defaults to `Agbota Segun` |
| `BTC_ADDRESS` | yes | Bitcoin wallet address shown in the payment UI |
| `PAYPAL_INSTRUCTIONS` | yes | PayPal instructions shown in the payment UI |
| `MAX_UPLOAD_MB` | optional | Upload size cap, default `10` |
| `PGSSL` | optional | `true` on Render, `false` locally |
| `ADMIN_RESET_PASSWORD` | optional | Set `true` once to reset the owner password from `ADMIN_PASSWORD` |

Secrets are **never** sent to the browser. `/api/config` exposes only booleans.

---

## Deploying to Render

### Option A — Blueprint (recommended)

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` creates the web
   service **and** a persistent PostgreSQL database, wiring `DATABASE_URL` automatically.
3. Set the two secret values in the dashboard (marked `sync: false`):
   - `ADMIN_PASSWORD` — a strong password for the owner account
   - `BTC_ADDRESS` — the real Bitcoin wallet address
4. Deploy. Health check: `GET /api/health` → `{"ok":true}`.

### Option B — Manual

1. Render → **New → PostgreSQL**, then copy the **Internal Database URL**.
2. Render → **New → Web Service** → connect the GitHub repo.
   - Build: `npm install`
   - Start: `npm start`
   - Health check path: `/api/health`
3. Add all environment variables from the table above (`PGSSL=true`).
4. Deploy.

On first boot the app creates every table, index and constraint, seeds the 14
strategies (idempotently — reruns never duplicate) and creates the owner account.

---

## Database schema

`profiles` · `sessions` · `files` · `products` · `orders` · `order_items` ·
`conversations` · `messages` · `message_attachments` · `payment_submissions` ·
`reviews` · `notifications` · `proof_items` · `contact_messages`

Foreign keys and indexes throughout. Email uniqueness is enforced by a
case-insensitive unique index (`profiles_email_unique`), so one email can never
create two accounts — even under a race condition.

---

## Key routes

**Public:** `/` `/strategies` `/strategy/:slug` `/proof-of-work` `/about` `/contact` `/access`
**Authenticated:** `/dashboard` `/chat` `/checkout/:slug`
**Owner only:** `/admin`

**API:** `/api/health` `/api/auth/*` `/api/products` `/api/orders` `/api/messages`
`/api/files/:id` `/api/proof` `/api/reviews` `/api/notifications` `/api/contact`
`/api/admin/*` (owner-only, enforced server-side).

---

## Troubleshooting login / session problems

**Symptom: login succeeds ("Welcome…") but you are bounced back to the login screen.**

Visit `/api/health/auth` on the live site. It returns no secrets, only diagnostics:

```json
{
  "jwtSecretFromEnv": true,
  "jwtSecretFingerprint": "8f67682269ef",
  "requestSeenAsSecure": true,
  "xForwardedProto": "https",
  "secureCookiesConfigured": true
}
```

- `jwtSecretFromEnv: false` → **`JWT_SECRET` is missing.** Every restart generates a
  new secret, instantly invalidating all sessions. Set it in Render and redeploy.
- `jwtSecretFingerprint` **changes between restarts** → `JWT_SECRET` is being changed.
  Set one permanent value and never edit it.
- `requestSeenAsSecure: false` while on HTTPS → the proxy headers are not trusted;
  ensure `TRUST_PROXY` is not set to `false`.

The app now refuses to boot on a deployed instance when `JWT_SECRET` is missing,
rather than silently rotating it, so this cannot recur.

## Security

bcrypt (cost 12) · httpOnly + SameSite cookies · DB-backed revocable sessions ·
server-side role authorization · parameterized SQL · MIME + size validation on
uploads · per-file access authorization · CSRF double-submit tokens · CSP and
security headers · auth rate limiting · HTML escaped on render · no secrets in
frontend code or logs.

---

## Honesty commitments built into the product

- **No fake proof.** The Proof of Work gallery renders only what the owner uploads.
- **No fake reviews.** A review row can only be created by the owner of a
  **completed** order, one per order.
- **No invented numbers.** No fabricated client names, results, analytics or payouts.
- **Custom pricing is honest.** The custom strategy is presented as
  "starting around $150+", with scope and final price agreed before payment.
