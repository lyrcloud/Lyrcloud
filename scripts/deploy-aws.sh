#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-lyrcloud-static-site}"
ZONE_STACK_NAME="${ZONE_STACK_NAME:-$STACK_NAME-zone}"
DOMAIN_NAME="${DOMAIN_NAME:-lyrcloud.com}"
SITE_BUCKET_NAME="${SITE_BUCKET_NAME:-lyrcloud.com}"
REGION="${AWS_REGION:-us-east-1}"
TEMPLATE_FILE="${TEMPLATE_FILE:-infra/aws/static-site.yml}"
ZONE_TEMPLATE_FILE="${ZONE_TEMPLATE_FILE:-infra/aws/route53-zone.yml}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
AWS_BIN="${AWS_BIN:-aws}"

if ! command -v "$AWS_BIN" >/dev/null 2>&1 && [ -x "./.local/bin/aws" ]; then
  AWS_BIN="./.local/bin/aws"
fi

if ! command -v "$AWS_BIN" >/dev/null 2>&1; then
  echo "AWS CLI is required. Install and configure it before running this script." >&2
  exit 1
fi

if [ -z "$HOSTED_ZONE_ID" ]; then
  "$AWS_BIN" cloudformation deploy \
    --region "$REGION" \
    --stack-name "$ZONE_STACK_NAME" \
    --template-file "$ZONE_TEMPLATE_FILE" \
    --parameter-overrides DomainName="$DOMAIN_NAME"

  HOSTED_ZONE_ID="$("$AWS_BIN" cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$ZONE_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue | [0]" \
    --output text)"

  NAME_SERVERS="$("$AWS_BIN" cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$ZONE_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue | [0]" \
    --output text)"

  if [ "${CONFIRM_DELEGATED:-}" != "1" ]; then
    echo "Route53 hosted zone is ready: $HOSTED_ZONE_ID"
    echo "Set these name servers at the registrar for $DOMAIN_NAME:"
    echo "$NAME_SERVERS" | tr ',' '\n'
    echo
    echo "After delegation has propagated, rerun with:"
    echo "CONFIRM_DELEGATED=1 npm run deploy:aws"
    exit 0
  fi
fi

npm run build

"$AWS_BIN" cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DomainName="$DOMAIN_NAME" \
    SiteBucketName="$SITE_BUCKET_NAME" \
    HostedZoneId="$HOSTED_ZONE_ID"

BUCKET="$("$AWS_BIN" cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue | [0]" \
  --output text)"

DISTRIBUTION_ID="$("$AWS_BIN" cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue | [0]" \
  --output text)"

"$AWS_BIN" s3 sync dist/ "s3://$BUCKET/" \
  --region "$REGION" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html"

"$AWS_BIN" s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "public,max-age=0,must-revalidate" \
  --content-type "text/html"

"$AWS_BIN" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  >/dev/null

"$AWS_BIN" cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output table
