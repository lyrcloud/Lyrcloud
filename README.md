# Lyrcloud

The Lyrcloud website (`www.lyrcloud.com`): a Cloudflare-style multi-page marketing site plus a preview dashboard at `/dash/`. No dependencies — just Node.js.

## Commands

```bash
npm run dev
npm run check
npm run build
npm run create:s3
npm run deploy:aws
```

- `npm run dev` starts a local server on port `5173` that rebuilds on every page load.
- `npm run check` builds the site, then fails on missing titles or broken internal links.
- `npm run build` renders every page into `dist/`.
- `npm run create:s3` creates the private S3 bucket stack for static site assets.
- `npm run deploy:aws` builds the site, creates/updates the AWS stack, syncs `dist/` to S3, and invalidates CloudFront.

## Project layout

| Path | What it is |
|---|---|
| `site/layout.mjs` | Shared header (with the Products mega-menu), footer, and HTML shell |
| `site/products.mjs` | Product catalog — each entry becomes `/products/<slug>/` and a nav item |
| `site/pages.mjs` | Every page and its route (`/pricing/` → `dist/pricing/index.html`) |
| `src/styles.css` | Site styles |
| `src/dash.js`, `src/dash.css` | Dashboard single-page app (hash routes such as `/dash/#/zones/example.com/dns`) |
| `src/auth.js` | Cognito Hosted UI sign-in (Google, GitHub) with PKCE; `/callback.html` completes it |

To add a page, add an entry to the `pages` array in `site/pages.mjs`. To add a product, add it to `site/products.mjs`.

## Sign-in and dashboard

Sign-in is real: `/login/` and `/sign-up/` send visitors to the Cognito Hosted UI (`lyrcloud-users` pool), which offers Google and GitHub. Cognito only accepts `/callback.html` as the redirect and `/index.html` as the logout page (on `https://www.lyrcloud.com` and `http://localhost:5173`), so keep those paths. Profile data in Settings comes from the account API (`GET /me`).

- **Email and password:** `/sign-up/` and `/login/` also have their own forms (`src/login.js`, `src/cognito.js`) that call the Cognito API directly: sign up → 6-digit email code (sent by Cognito) → optional mobile number → texted code. Forgot-password works the same way. Run `python3 scripts/configure-auth.py` (report) then `--apply` to turn self sign-up and the code emails on in the pool.
- **Mobile numbers:** the account API texts the code through Amazon SNS (`POST /me/phone`, `POST /me/phone/verify`) and stores only a hash of it. New SNS accounts are in the SMS sandbox with a $1/month spend limit.
- **Emails:** the account API sends a welcome email to each new account and lets the super admin email product updates from the admin console (Settings tab), through Amazon SES from `no-reply@lyrcloud.com`. Each update has a signed unsubscribe link, and people can switch updates off in Account settings. SES needs the `lyrcloud.com` DKIM records in Cloudflare and production access before it can mail everyone.
- **GitHub:** GitHub isn't an OpenID provider, so `api/github-bridge/` makes it look like one for Cognito. It runs in the `lyrcloud-github-bridge` stack, whose secret `lyrcloud/github-bridge` holds the GitHub OAuth app credentials and signing key. Update it with `bash scripts/deploy-github-bridge.sh`, and point Cognito at it with `configure-auth.py --apply --github-bridge https://3ahe2e3r86.execute-api.us-east-1.amazonaws.com`. `GITHUB_SIGN_IN_ENABLED` in `site/pages.mjs` shows or hides the button.

The dashboard itself is not backed by a server yet:

- **Real:** adding a site scans its existing DNS records over public DNS-over-HTTPS (dns.google), and “Check nameservers” looks up the domain’s live NS records. The Edge Functions preview runs code in an isolated Web Worker in the browser.
- **Preview only:** websites, DNS records, functions, and settings are stored in the visitor’s browser (localStorage). Analytics and security events are generated sample data and labeled as such.

## Domains

Lyrcloud resells domains through Route 53 Domains, with its own commission on top, paid with Stripe. The public search and price list are at `/domains/` (`src/domains.js`); buying, transfers, renewals and DNS records are in the dashboard (`/dash/#/domains`), and prices, payments and sales are in the admin console's Domains tab.

- **Backend:** `api/domains/` in the `lyrcloud-domains` stack (`infra/aws/domains.yml`, table `lyrcloud-domains`). Deploy with `bash scripts/deploy-domains.sh`; `DOMAINS_API_BASE` in `src/auth.js` points at its API.
- **Money first:** checkout holds the name for 35 minutes and opens Stripe Checkout. Only when Stripe's webhook confirms the payment does the API call `RegisterDomain`/`TransferDomain`; if the registrar refuses (straight away or later), the payment is refunded automatically. In Stripe **test mode** paid orders are always refunded and never reach the registrar, so the flow can be tried without buying real domains.
- **Renewals:** Route 53 auto-renew is off. A scheduled run every 15 minutes follows registrar operations and, 30 days before expiry, charges the saved card off-session for auto-renewing domains, then calls `RenewDomain`. Failed charges are retried daily and shown on the domain.
- **Prices:** customer price = (Route 53 price + DNS hosting) × (1 + commission %) + flat fee, optionally rounded up to .99, never below cost. DNS hosting (default $6/yr, a Route 53 hosted zone) applies to registrations and their renewals; transfers keep their own DNS. The super admin sets the commission, TLD list and per-TLD overrides in the admin console.
- **Stripe:** the super admin pastes a secret key in the admin console; the API checks it, registers its own webhook (`/public/stripe/webhook`) and keeps both in the `lyrcloud/stripe` secret.
- **DNS:** registered domains get a Route 53 hosted zone; owners edit A, AAAA, CNAME, MX and TXT records in the dashboard, and the domain shows up as an active website.

## Theme

Light by default; dark when the visitor’s OS prefers dark. Colors are tokens on `:root` in `src/styles.css`.

## AWS hosting

The AWS deployment is defined in [infra/aws/static-site.yml](infra/aws/static-site.yml). It creates:

- a bucket policy for the private S3 bucket created by [infra/aws/s3-bucket.yml](infra/aws/s3-bucket.yml)
- a Lambda@Edge viewer-request function for clean URL rewrites
- an ACM certificate for `lyrcloud.com` and `www.lyrcloud.com`
- a CloudFront distribution with the S3 bucket as a private origin
- `A`/`AAAA` Route53 alias records for the apex and `www`

Run it from a machine or CI runner with AWS CLI credentials:

```bash
AWS_REGION=us-east-1 npm run create:s3
AWS_REGION=us-east-1 npm run deploy:aws
```

The first run creates a Route53 public hosted zone from [infra/aws/route53-zone.yml](infra/aws/route53-zone.yml), prints the name servers, and stops. Add those name servers at the registrar for `lyrcloud.com`, then run:

```bash
CONFIRM_DELEGATED=1 AWS_REGION=us-east-1 npm run deploy:aws
```

Optional overrides:

```bash
STACK_NAME=lyrcloud-static-site \
DOMAIN_NAME=lyrcloud.com \
SITE_BUCKET_NAME=lyrcloud.com \
HOSTED_ZONE_ID=Z1234567890 \
AWS_REGION=us-east-1 \
npm run deploy:aws
```

CloudFront requires the ACM certificate and Lambda@Edge function to live in `us-east-1`, so keep `AWS_REGION=us-east-1` unless you also change the architecture.
