# Lyrcloud Landing Page

A Cloudflare-inspired, original static landing page for `www.lyrcloud.com`. The site is intentionally dependency-free and can be served by any static host.

## Commands

```bash
npm run dev
npm run check
npm run build
npm run create:s3
npm run deploy:aws
```

- `npm run dev` starts a small local Node.js static server on port `5173`.
- `npm run check` verifies that the required source files and core Lyrcloud content are present.
- `npm run build` copies the static assets into `dist/`.
- `npm run create:s3` creates the private S3 bucket stack for static site assets.
- `npm run deploy:aws` builds the site, creates/updates the AWS stack, syncs `dist/` to S3, and invalidates CloudFront.

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
