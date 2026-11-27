#!/usr/bin/env bash
# Deploys the Lyrcloud CDN for customer domains (infra/aws/sites.yml): two multi-tenant CloudFront
# distributions (customer origins, and Edge Functions through the router's URL). Run after
# scripts/deploy-functions.sh (it creates the router URL), then rerun scripts/deploy-domains.sh so the
# domains API learns the distribution IDs.
set -euo pipefail

STACK="${STACK:-lyrcloud-sites}"

router_url="$(aws cloudformation describe-stacks --stack-name lyrcloud-functions \
  --query "Stacks[0].Outputs[?OutputKey=='RouterUrl'].OutputValue" --output text)"
[[ "$router_url" == https://* ]] || { echo "No RouterUrl output on lyrcloud-functions: run scripts/deploy-functions.sh first." >&2; exit 1; }
router_host="${router_url#https://}"; router_host="${router_host%/}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The origin secret is derived from the platform secret exactly as the router does (cdnOriginSecret), and
# passed through a file so it never appears in a command line.
aws secretsmanager get-secret-value --secret-id lyrcloud/functions-platform --query SecretString --output text |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHmac("sha256",s.trim()).update("lyr-cdn-origin").digest("hex")))' >"$work/secret"
python3 - "$work/secret" "$router_host" >"$work/params.json" <<'PY'
import json, sys
print(json.dumps([
    {"ParameterKey": "RouterUrlHost", "ParameterValue": sys.argv[2]},
    {"ParameterKey": "OriginSecret", "ParameterValue": open(sys.argv[1]).read().strip()},
]))
PY

if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  aws cloudformation update-stack --stack-name "$STACK" --template-body file://infra/aws/sites.yml \
    --parameters "file://$work/params.json" >/dev/null 2>"$work/err" || grep -q "No updates" "$work/err" || { cat "$work/err" >&2; exit 1; }
  aws cloudformation wait stack-update-complete --stack-name "$STACK"
else
  aws cloudformation create-stack --stack-name "$STACK" --template-body file://infra/aws/sites.yml \
    --parameters "file://$work/params.json" >/dev/null
  aws cloudformation wait stack-create-complete --stack-name "$STACK"
fi
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
