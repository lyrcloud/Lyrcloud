#!/usr/bin/env bash
# Updates the GitHub → OIDC bridge (the lyrcloud-github-bridge stack, infra/aws/github-bridge.yml) with the
# code in api/github-bridge/. Its address, signing key and GitHub app credentials stay as they are. Then:
#   python3 scripts/configure-auth.py --apply --github-bridge <BridgeApiBaseUrl printed below>
set -euo pipefail

STACK="${STACK:-lyrcloud-github-bridge}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"

node --test api/github-bridge/index.test.mjs

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The Lambda runtime provides the AWS SDK, so the bridge is a single file. Python's zipfile works
# everywhere (no zip binary needed).
python3 - "$work/code.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    info = zipfile.ZipInfo('index.mjs', date_time=(2020, 1, 1, 0, 0, 0))
    info.external_attr = 0o644 << 16
    z.writestr(info, open('api/github-bridge/index.mjs', 'rb').read(), zipfile.ZIP_DEFLATED)
PY
key="github-bridge/$(sha256sum "$work/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$work/code.zip" "s3://$ARTIFACTS_BUCKET/$key" >/dev/null

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/aws/github-bridge.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" \
    "AllowedRedirectUri=https://lyrcloud-auth.auth.us-east-1.amazoncognito.com/oauth2/idpresponse"

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
