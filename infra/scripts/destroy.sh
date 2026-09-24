#!/usr/bin/env bash
set -euo pipefail

AUTO_APPROVE=false

if [[ $# -gt 0 ]]; then
  case "$1" in
    -auto-approve|--auto-approve)
      AUTO_APPROVE=true
      ;;
    -h|--help)
      echo "Usage: $0 [-auto-approve|--auto-approve]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [-auto-approve|--auto-approve]" >&2
      exit 1
      ;;
  esac
fi

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is required (example: export AWS_REGION=eu-west-1)" >&2
  exit 1
fi

if [[ "${AUTO_APPROVE}" != "true" ]]; then
  echo "Destroy is destructive. Review the plan and re-run with -auto-approve only after approval." >&2
  echo "Example: AWS_REGION=eu-west-1 ./infra/scripts/destroy.sh -auto-approve" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

terraform init -input=false
terraform plan -destroy -input=false -out=tfplan-destroy
terraform apply -input=false tfplan-destroy
