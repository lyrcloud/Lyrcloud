#!/usr/bin/env bash
# Deploys Lyrcloud Domains (infra/aws/domains.yml): the domains API and its 15-minute scheduled run
# (api/domains/). Reuses the account API's Cognito user pool. name.$SUBDOMAIN_ZONE subdomains switch on by
# themselves once that domain has a Route 53 hosted zone (registering it creates one); redeploy then. Works without esbuild or zip (Python packs
# the code). After the first deploy, set DOMAINS_API_BASE in src/auth.js to the printed API URL and
# connect Stripe from the admin console (Admin console -> Domains).
set -euo pipefail

STACK="${STACK:-lyrcloud-domains}"
SUBDOMAIN_ZONE="${SUBDOMAIN_ZONE:-lyr.cloud}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"

node --test api/domains/rules.test.mjs api/domains/lyrdns.test.mjs api/domains/handler.test.mjs

param() {
  aws cloudformation describe-stacks --stack-name lyrcloud-account-api \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}
pool="$(param UserPoolId)"
client="$(param UserPoolClientId)"

zone_id="$(aws route53 list-hosted-zones-by-name --dns-name "$SUBDOMAIN_ZONE" --max-items 1 \
  --query "HostedZones[?Name=='$SUBDOMAIN_ZONE.' && !Config.PrivateZone].Id | [0]" --output text)"
if [[ "$zone_id" == None || -z "$zone_id" ]]; then
  echo "No hosted zone for $SUBDOMAIN_ZONE yet: name.$SUBDOMAIN_ZONE stays switched off."
  sub_zone=""; zone_id=""
else
  sub_zone="$SUBDOMAIN_ZONE"; zone_id="${zone_id##*/}"
  echo "name.$SUBDOMAIN_ZONE subdomains are on (hosted zone $zone_id)."
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 - "$work/code.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ['index', 'rules', 'lyrdns']:
        z.write(f'api/domains/{name}.mjs', f'domains/{name}.mjs')
    for name in ['roles', 'phone']:
        z.write(f'api/account/{name}.mjs', f'account/{name}.mjs')
PY
key="domains/$(sha256sum "$work/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$work/code.zip" "s3://$ARTIFACTS_BUCKET/$key" --only-show-errors

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/aws/domains.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" "UserPoolId=$pool" "UserPoolClientId=$client" \
    "SubdomainZone=$sub_zone" "SubdomainZoneId=$zone_id"

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
