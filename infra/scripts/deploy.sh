#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--apply] [--plan-only]"
  exit 1
}

APPLY=false
PLAN_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      ;;
    --plan-only)
      PLAN_ONLY=true
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
  shift
done

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is required (example: export AWS_REGION=eu-west-1)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

terraform init -input=false
terraform validate
terraform plan -input=false -out=tfplan

if [[ "${PLAN_ONLY}" == "true" ]]; then
  echo "Terraform plan created at ./infra/tfplan. Review it before apply."
  exit 0
fi

if [[ "${APPLY}" == "true" ]]; then
  terraform apply -input=false tfplan
else
  echo "No apply requested. Review the plan and re-run with --apply when ready."
fi
