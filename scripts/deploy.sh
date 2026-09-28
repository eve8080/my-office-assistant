#!/bin/bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-agent-dev}"
REGION="${AWS_REGION:-ap-southeast-1}"
STACK_NAME="${STACK_NAME:-my-office-assistant}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT_DIR/infra/template.yaml"
WEB_DIR="$ROOT_DIR/web"
OUTPUT_FILE="$ROOT_DIR/.aws-output.json"

aws --profile "$PROFILE" --region "$REGION" cloudformation validate-template \
  --template-body "file://$TEMPLATE" >/dev/null

aws --profile "$PROFILE" --region "$REGION" cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --no-fail-on-empty-changeset \
  --tags Application="My Office Assistant"

BUCKET_NAME="$(aws --profile "$PROFILE" --region "$REGION" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
DISTRIBUTION_ID="$(aws --profile "$PROFILE" --region "$REGION" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)"
DOMAIN_NAME="$(aws --profile "$PROFILE" --region "$REGION" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomainName'].OutputValue" --output text)"

aws --profile "$PROFILE" --region "$REGION" s3 sync "$WEB_DIR/" "s3://$BUCKET_NAME/" \
  --delete \
  --cache-control "public,max-age=300" \
  --exclude "index.html"
aws --profile "$PROFILE" --region "$REGION" s3 cp "$WEB_DIR/index.html" "s3://$BUCKET_NAME/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache, no-store, must-revalidate"

INVALIDATION_ID="$(aws --profile "$PROFILE" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' --output text)"
aws --profile "$PROFILE" cloudfront wait invalidation-completed \
  --distribution-id "$DISTRIBUTION_ID" \
  --id "$INVALIDATION_ID"

cat > "$OUTPUT_FILE" <<JSON
{
  "profile": "$PROFILE",
  "region": "$REGION",
  "stack_name": "$STACK_NAME",
  "bucket_name": "$BUCKET_NAME",
  "distribution_id": "$DISTRIBUTION_ID",
  "invalidation_id": "$INVALIDATION_ID",
  "domain_name": "$DOMAIN_NAME",
  "url": "https://$DOMAIN_NAME"
}
JSON

printf 'url=https://%s\ndistribution_id=%s\ninvalidation_id=%s\n' \
  "$DOMAIN_NAME" "$DISTRIBUTION_ID" "$INVALIDATION_ID"
