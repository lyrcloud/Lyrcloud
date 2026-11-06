#!/usr/bin/env bash
# Deploys Lyrcloud Domains (infra/aws/domains.yml): the domains API and its 15-minute scheduled run
# (api/domains/). Reuses the account API's Cognito user pool. name.$SUBDOMAIN_ZONE subdomains switch on by
# themselves once that domain has a Route 53 hosted zone (registering it creates one); redeploy then. Works without esbuild or zip (Python packs
# the code). After the first deploy, set DOMAINS_API_BASE in src/auth.js to the printed API URL and
# connect Stripe from the admin console (Admin console -> Domains).
#
# Domains are bought from DNA (Domain Name API). Set DNA_API_KEY, DNA_RESELLER_ID and DNA_TEST_API_KEY (from
# the DNA reseller panel, under API settings) to store them in the lyrcloud/dna secret; leave them unset to
# keep the stored ones. Live purchases are paid from the prepaid DNA balance, so keep it topped up.
set -euo pipefail

STACK="${STACK:-lyrcloud-domains}"
SUBDOMAIN_ZONE="${SUBDOMAIN_ZONE:-lyr.cloud}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"

node --test api/domains/rules.test.mjs api/domains/lyrdns.test.mjs api/domains/lyrca.test.mjs api/domains/handler.test.mjs

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
    for name in ['index', 'rules', 'lyrdns', 'lyrca', 'dna']:
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

if [[ -n "${DNA_API_KEY:-}" && -n "${DNA_RESELLER_ID:-}" ]]; then
  # Read from the environment by Python, so the keys never appear in a command line or the shell history.
  python3 -c 'import json, os; print(json.dumps({"apiKey": os.environ["DNA_API_KEY"], "resellerId": os.environ["DNA_RESELLER_ID"], "testApiKey": os.environ.get("DNA_TEST_API_KEY", "")}))' \
    >"$work/dna.json"
  aws secretsmanager put-secret-value --secret-id lyrcloud/dna --secret-string "file://$work/dna.json" >/dev/null
  echo "Stored the DNA credentials in lyrcloud/dna."
elif [[ "$(aws secretsmanager get-secret-value --secret-id lyrcloud/dna --query SecretString --output text)" == '{}' ]]; then
  echo "WARNING: no DNA credentials stored yet. Rerun with DNA_API_KEY, DNA_RESELLER_ID and DNA_TEST_API_KEY set; until then nothing can be bought."
fi

if [[ "$(aws secretsmanager get-secret-value --secret-id lyrcloud/lyr-ca --query SecretString --output text)" == '{}' ]]; then
  echo "NOTE: no Lyr Root CA yet, so .lyr names can't get HTTPS certificates. Run: node scripts/lyr-root-ca.mjs"
fi

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
