#!/usr/bin/env bash
# Deploys Lyrcloud Cloud (infra/aws/cloud.yml): the cloud API (api/cloud/) and the public access-role
# template customers install in their own AWS account. Reuses the account API's Cognito user pool.
# Works without esbuild or zip (Python packs the code; the Lambda uses the runtime's AWS SDK).
# After the first deploy, set CLOUD_API_BASE in src/auth.js to the printed API URL.
set -euo pipefail

STACK="${STACK:-lyrcloud-cloud}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"

node --test api/cloud/rules.test.mjs api/cloud/handler.test.mjs

param() {
  aws cloudformation describe-stacks --stack-name lyrcloud-account-api \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}
pool="$(param UserPoolId)"
client="$(param UserPoolClientId)"
account="$(aws sts get-caller-identity --query Account --output text)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Keeps the repo layout (api/cloud -> ../account, ../../src) so the same imports work locally and in Lambda.
python3 - "$work/code.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('package.json', '{"type": "module"}\n')
    for path in ['api/cloud/index.mjs', 'api/cloud/rules.mjs', 'api/account/roles.mjs', 'api/account/phone.mjs', 'src/clouds.js', 'src/cloud-pricing.js']:
        z.write(path, path)
PY
key="cloud/$(sha256sum "$work/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$work/code.zip" "s3://$ARTIFACTS_BUCKET/$key" --only-show-errors

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/aws/cloud.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" "UserPoolId=$pool" "UserPoolClientId=$client"

# The template customers install: trusts this account, with each customer's own ExternalId.
bucket="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='PublicBucketName'].OutputValue" --output text)"
node -e "import('./api/cloud/rules.mjs').then((m) => process.stdout.write(JSON.stringify(m.accessRoleTemplate('$account'), null, 2)))" > "$work/access-role.json"
aws s3 cp "$work/access-role.json" "s3://$bucket/cloud/access-role.json" --only-show-errors \
  --content-type application/json --cache-control "public,max-age=300"

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
