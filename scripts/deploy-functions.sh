#!/usr/bin/env bash
# Deploys Lyrcloud Edge Functions (infra/aws/functions.yml): the API the `lyrcloud` CLI talks to
# (api/functions/index.mjs), the router that serves <name>.dev.lyr (api/functions/router.mjs), and the
# daily *.dev.lyr certificate renewal. Needs the Lyr Root CA secret (scripts/lyr-root-ca.mjs) and the
# lyrcloud-domains stack (its table holds the .lyr registry). The Lambda runtime's own AWS SDK is used,
# so only our files are packed.
set -euo pipefail

STACK="${STACK:-lyrcloud-functions}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"
FUNCTIONS_DOMAIN="${FUNCTIONS_DOMAIN:-dev.lyr}"

for f in zip runtime; do cmp -s "api/functions/$f.mjs" "cli/lib/$f.mjs" || { echo "cli/lib/$f.mjs differs from api/functions/$f.mjs" >&2; exit 1; }; done
node --test api/functions/rules.test.mjs api/functions/handler.test.mjs api/functions/storage.test.mjs api/functions/ai.test.mjs api/functions/access.test.mjs api/functions/security.test.mjs

param() {
  aws cloudformation describe-stacks --stack-name lyrcloud-account-api \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}
pool="$(param UserPoolId)"
client="$(param UserPoolClientId)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
python3 - "$work/code.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ['index', 'router', 'rules', 'runtime', 'zip', 'platform', 'storage', 'ai', 'access', 'security']:
        z.write(f'api/functions/{name}.mjs', f'functions/{name}.mjs')
    for name in ['roles', 'phone']:
        z.write(f'api/account/{name}.mjs', f'account/{name}.mjs')
    z.write('api/domains/lyrca.mjs', 'domains/lyrca.mjs')
PY
key="functions/$(sha256sum "$work/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$work/code.zip" "s3://$ARTIFACTS_BUCKET/$key" --only-show-errors

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/aws/functions.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" "FunctionsDomain=$FUNCTIONS_DOMAIN" \
    "UserPoolId=$pool" "UserPoolClientId=$client"

# Issue (or confirm) the *.dev.lyr certificate now rather than on the first deploy.
aws lambda invoke --function-name lyrcloud-functions --cli-binary-format raw-in-base64-out \
  --payload '{"task":"renew-certificate"}' "$work/cert.json" >/dev/null
echo "Certificate: $(cat "$work/cert.json")"

api="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='FunctionsApiBaseUrl'].OutputValue" --output text)"
echo "Functions API: $api"
grep -q "$api" cli/lib/config.mjs || echo "Set DEFAULT_API in cli/lib/config.mjs to $api and publish the CLI again."
