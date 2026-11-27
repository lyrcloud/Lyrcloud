#!/usr/bin/env bash
# Builds Lyrcloud managed hosting's shared base in this AWS account (infra/aws/hosting.yml) and records its
# outputs for the cloud API. Run once (and again after changing the template). Hosting stays off for customers
# until the super admin switches it on in Admin console > Cloud. Costs while idle: one load balancer (~$20/month).
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-lyrcloud-hosting}"

role_arn="$(aws lambda get-function-configuration --function-name lyrcloud-cloud --query Role --output text)"
role_name="${role_arn##*/}"
prefix_list="$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)"
echo "Cloud API role: $role_name · CloudFront origin prefix list: $prefix_list"

aws cloudformation deploy --stack-name "$STACK" --template-file infra/aws/hosting.yml --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset --parameter-overrides "CloudFunctionRoleName=$role_name" "CloudFrontPrefixListId=$prefix_list"

table="$(aws cloudformation describe-stacks --stack-name lyrcloud-cloud --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" --output text)"
[[ "$table" == None || -z "$table" ]] && table=lyrcloud-cloud
outputs="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)"
item="$(python3 - "$outputs" "$AWS_REGION" <<'PY'
import json, sys
outputs = {o['OutputKey']: o['OutputValue'] for o in json.loads(sys.argv[1])}
item = {'pk': {'S': '#settings'}, 'sk': {'S': 'hosting'}, 'Region': {'S': sys.argv[2]}}
item.update({key: {'S': value} for key, value in outputs.items()})
print(json.dumps(item))
PY
)"
aws dynamodb put-item --table-name "$table" --item "$item"
echo "Hosting base ready and recorded in $table. Switch it on in Admin console > Cloud > Managed hosting."
