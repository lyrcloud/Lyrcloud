#!/usr/bin/env bash
# Deploys Lyrcloud Projects (infra/aws/projects.yml): the projects API and publisher (api/projects/),
# the CodeBuild builder, and the *.lyrcloud.app CloudFront setup with its router.
# Needs the sites domain's Route 53 hosted zone. Works without esbuild or zip (Python packs the code).
set -euo pipefail

STACK="${STACK:-lyrcloud-projects}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"
SITES_DOMAIN="${SITES_DOMAIN:-lyrcloud.app}"

node --test api/projects/rules.test.mjs api/projects/handler.test.mjs

zone="$(aws route53 list-hosted-zones-by-name --dns-name "$SITES_DOMAIN" --query "HostedZones[?Name=='$SITES_DOMAIN.'].Id | [0]" --output text)"
[[ "$zone" != None && -n "$zone" ]] || { echo "No Route 53 hosted zone for $SITES_DOMAIN" >&2; exit 1; }
zone="${zone##*/}"
param() {
  aws cloudformation describe-stacks --stack-name lyrcloud-account-api \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}
pool="$(param UserPoolId)"
client="$(param UserPoolClientId)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The Lambda ships with its own AWS SDK clients (the router's key store needs SigV4A signing, which the
# runtime's SDK lacks), so pack api/projects, api/account/roles.mjs and the needed node_modules.
python3 - "$work/code.zip" <<'PY'
import json, os, sys, zipfile

def requirements(package_json):
    meta = json.load(open(package_json))
    return {**meta.get('dependencies', {}), **meta.get('optionalDependencies', {})}

def deps(name, seen):
    """Adds top-level package `name` and everything it needs, including what its nested copies need."""
    if name in seen:
        return
    folder = os.path.join('node_modules', name)
    if not os.path.exists(os.path.join(folder, 'package.json')):
        return
    seen.add(name)
    for root, dirs, files in os.walk(folder):
        if 'package.json' in files and (root == folder or os.path.basename(os.path.dirname(root)) in ('node_modules',) or os.path.basename(os.path.dirname(os.path.dirname(root))) == 'node_modules'):
            for dep in requirements(os.path.join(root, 'package.json')):
                deps(dep, seen)

needed = set()
for root in ['@aws-sdk/client-cloudfront-keyvaluestore', '@aws-sdk/signature-v4a', '@aws-sdk/client-codebuild', '@aws-sdk/client-s3',
             '@aws-sdk/client-cloudwatch-logs', '@aws-sdk/client-secrets-manager', '@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb']:
    deps(root, needed)

with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ['index', 'rules', 'github', 'buildspec', 'sigv4a']:
        z.write(f'api/projects/{name}.mjs', f'projects/{name}.mjs')
    for name in ['roles', 'phone']:
        z.write(f'api/account/{name}.mjs', f'account/{name}.mjs')
    for dep in sorted(needed):
        for root, _, files in os.walk(os.path.join('node_modules', dep)):
            for f in files:
                if not f.endswith(('.d.ts', '.map', '.md')):
                    z.write(os.path.join(root, f))
print(f'{len(needed)} packages', file=sys.stderr)
PY
key="projects/$(sha256sum "$work/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$work/code.zip" "s3://$ARTIFACTS_BUCKET/$key" --only-show-errors

router="$(sed "s/__DOMAIN__/$SITES_DOMAIN/g" infra/cloudfront/sites-router.js)"

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/aws/projects.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" "ArtifactsBucketName=$ARTIFACTS_BUCKET" "SitesDomain=$SITES_DOMAIN" \
    "HostedZoneId=$zone" "UserPoolId=$pool" "UserPoolClientId=$client" "RouterCode=$router"

bucket="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='SitesBucketName'].OutputValue" --output text)"
aws s3 cp infra/cloudfront/sites-404.html "s3://$bucket/_lyrcloud/404.html" --content-type 'text/html; charset=utf-8' \
  --cache-control 'public, max-age=300' --only-show-errors

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
