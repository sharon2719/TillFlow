#!/usr/bin/env bash
# G5 destroy → rebuild script.
# Runs the full sequence and tees all output to a timestamped log under evidence/.
# Review the destroy plan before passing -auto-approve.
#
# Usage:
#   export AWS_REGION=eu-west-1
#   ./infra/scripts/rebuild.sh --plan-only          # review destroy plan, no changes
#   ./infra/scripts/rebuild.sh --auto-approve        # full run, captures evidence log
set -euo pipefail

PLAN_ONLY=false
AUTO_APPROVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan-only)    PLAN_ONLY=true ;;
    --auto-approve) AUTO_APPROVE=true ;;
    -h|--help)
      echo "Usage: $0 [--plan-only | --auto-approve]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--plan-only | --auto-approve]" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is required (example: export AWS_REGION=eu-west-1)" >&2
  exit 1
fi

if [[ -z "${AWS_PROFILE:-}" ]]; then
  echo "AWS_PROFILE is required (example: export AWS_PROFILE=devops-g5)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
EVIDENCE_DIR="$REPO_ROOT/evidence/platform-delivery"
DATE="$(date -u +%Y-%m-%d)"
LOG="$EVIDENCE_DIR/g5-destroy-rebuild-${DATE}.txt"
API_ENDPOINT="https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com"
NAME_PREFIX="devops-g5"

mkdir -p "$EVIDENCE_DIR"

# Tee everything to the evidence log from this point on.
exec > >(tee -a "$LOG") 2>&1

echo "# G5 destroy → rebuild run"
echo "UTC start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Region: $AWS_REGION"
echo "Log: $LOG"
echo ""

cd "$INFRA_DIR"
terraform init -input=false -no-color

# ── Step 1: pre-destroy inventory ────────────────────────────────────────────
echo "## Step 1 — pre-destroy resource inventory"
echo "### Tagged resources (capstone=tillflow)"
aws resourcegroupstaggingapi get-resources \
  --region "$AWS_REGION" \
  --tag-filters Key=capstone,Values=tillflow \
  --output json

echo ""
echo "### ECR images"
for repo in pos payments commission web grafana; do
  echo "#### $NAME_PREFIX-$repo"
  aws ecr list-images \
    --region "$AWS_REGION" \
    --repository-name "$NAME_PREFIX-$repo" \
    --output json 2>/dev/null || echo "(no images or repo not found)"
done

echo ""
echo "### ECS service task counts (before destroy)"
for svc in pos payments commission web grafana; do
  aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$NAME_PREFIX-cluster" \
    --services "$NAME_PREFIX-$svc" \
    --query 'services[0].{service:serviceName,running:runningCount,desired:desiredCount}' \
    --output json 2>/dev/null || echo "(service $svc not found)"
done

# ── Step 2: destroy plan ──────────────────────────────────────────────────────
echo ""
echo "## Step 2 — terraform plan -destroy"
DESTROY_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Destroy plan started: $DESTROY_START"
terraform plan -destroy -input=false -no-color -out=tfplan-destroy

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo ""
  echo "Plan-only mode. Review tfplan-destroy then re-run with --auto-approve."
  echo "Log written to: $LOG"
  exit 0
fi

if [[ "$AUTO_APPROVE" != "true" ]]; then
  echo "Pass --auto-approve to proceed with destroy." >&2
  exit 2
fi

# ── Step 3: destroy ───────────────────────────────────────────────────────────
echo ""
echo "## Step 3 — terraform destroy"
DESTROY_APPLY_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Destroy apply started: $DESTROY_APPLY_START"
terraform apply -input=false -no-color tfplan-destroy
DESTROY_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Destroy completed: $DESTROY_END"

# ── Step 4: rebuild ───────────────────────────────────────────────────────────
echo ""
echo "## Step 4 — terraform apply (rebuild)"
REBUILD_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Rebuild started: $REBUILD_START"
terraform plan -input=false -no-color -out=tfplan-rebuild
terraform apply -input=false -no-color tfplan-rebuild
REBUILD_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Rebuild completed: $REBUILD_END"

echo ""
echo "## Step 5 — post-rebuild outputs"
terraform output -no-color

# ── Step 6: post-rebuild health check ────────────────────────────────────────
echo ""
echo "## Step 6 — post-rebuild health verification"
echo "Waiting 120s for ECS tasks to stabilise..."
sleep 120

echo ""
echo "### ECS service task counts (after rebuild)"
for svc in pos payments commission web grafana; do
  aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$NAME_PREFIX-cluster" \
    --services "$NAME_PREFIX-$svc" \
    --query 'services[0].{service:serviceName,running:runningCount,desired:desiredCount}' \
    --output json 2>/dev/null || echo "(service $svc not found)"
done

echo ""
echo "### Public endpoint health check"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$API_ENDPOINT/health" || echo "FAILED")
echo "GET $API_ENDPOINT/health -> HTTP $HTTP_STATUS"

echo ""
echo "### POS health (direct)"
curl -s --max-time 15 "$API_ENDPOINT/health" || echo "(no response)"

VERIFY_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
echo "## Summary"
echo "Destroy plan started:  $DESTROY_START"
echo "Destroy apply started: $DESTROY_APPLY_START"
echo "Destroy completed:     $DESTROY_END"
echo "Rebuild started:       $REBUILD_START"
echo "Rebuild completed:     $REBUILD_END"
echo "Verification done:     $VERIFY_END"
echo "Public endpoint HTTP:  $HTTP_STATUS"
echo ""
echo "Log written to: $LOG"
echo "Next: commit $LOG and update evidence/platform-delivery/README.md and docs/cost-and-teardown.md."
