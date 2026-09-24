#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is required (example: export AWS_REGION=eu-west-1)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

terraform init -input=false
terraform validate
terraform plan -input=false

read -r -p "Apply bootstrap infrastructure? [y/N]: " confirm
if [[ "${confirm}" =~ ^[Yy]$ ]]; then
  terraform apply -input=false
else
  echo "Bootstrap not applied. Review the plan first." >&2
fi
