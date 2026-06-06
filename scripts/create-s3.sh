#!/usr/bin/env bash
set -euo pipefail

S3_STACK_NAME="${S3_STACK_NAME:-lyrcloud-static-site-s3}"
SITE_BUCKET_NAME="${SITE_BUCKET_NAME:-lyrcloud.com}"
REGION="${AWS_REGION:-us-east-1}"
TEMPLATE_FILE="${S3_TEMPLATE_FILE:-infra/aws/s3-bucket.yml}"
AWS_BIN="${AWS_BIN:-aws}"

if ! command -v "$AWS_BIN" >/dev/null 2>&1 && [ -x "./.local/bin/aws" ]; then
  AWS_BIN="./.local/bin/aws"
fi

if ! command -v "$AWS_BIN" >/dev/null 2>&1; then
  echo "AWS CLI is required. Install and configure it before running this script." >&2
  exit 1
fi

"$AWS_BIN" cloudformation deploy \
  --region "$REGION" \
  --stack-name "$S3_STACK_NAME" \
  --template-file "$TEMPLATE_FILE" \
  --parameter-overrides SiteBucketName="$SITE_BUCKET_NAME"

"$AWS_BIN" cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$S3_STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output table
