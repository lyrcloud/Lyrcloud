#!/usr/bin/env bash
# Deploys the GitHub → OIDC bridge (infra/aws/github-bridge.yml, api/github-bridge/) as its own stack,
# creating the id_token signing key in Secrets Manager the first time. Then point Cognito at it:
#   python3 scripts/configure-auth.py --apply --github-bridge <BridgeUrl printed below>
# and set the GitHub OAuth app's "Authorization callback URL" to <BridgeUrl>/callback.
set -euo pipefail

STACK="${STACK:-lyrcloud-github-oidc}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"
KEY_SECRET="${KEY_SECRET:-lyrcloud/github-bridge-signing-key}"

node --test api/github-bridge/index.test.mjs

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

if ! aws secretsmanager describe-secret --secret-id "$KEY_SECRET" >/dev/null 2>&1; then
  node -e "const { generateKeyPairSync } = require('node:crypto');
    process.stdout.write(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));" >"$work/key.pem"
  aws secretsmanager create-secret --name "$KEY_SECRET" --description 'Signs id_tokens from the Lyrcloud GitHub OIDC bridge' \
    --secret-string "file://$work/key.pem" >/dev/null
  rm -f "$work/key.pem"
  echo "Created signing key secret $KEY_SECRET"
fi

# The Lambda runtime provides the AWS SDK, so the bridge is a single file.
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
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" "KeySecretName=$KEY_SECRET"

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
