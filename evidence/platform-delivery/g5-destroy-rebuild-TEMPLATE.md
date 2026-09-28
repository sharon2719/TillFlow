# G5 destroy → rebuild evidence
UTC date: <!-- PASTE: date of run, e.g. 2026-09-25 -->
Owner: sharon2719
Script: infra/scripts/rebuild.sh --auto-approve
Log: evidence/platform-delivery/g5-destroy-rebuild-<!-- PASTE: date -->.txt

## Summary

Full terraform destroy → terraform apply → post-rebuild 200 executed live against
the deployed stack in eu-west-1. Proves the workload can be reconstructed entirely
from the repository.

| Phase | UTC timestamp | Notes |
|---|---|---|
| Destroy plan started | <!-- PASTE --> | `terraform plan -destroy` |
| Destroy apply started | <!-- PASTE --> | `terraform apply tfplan-destroy` |
| Destroy completed | <!-- PASTE --> | all resources removed |
| Rebuild started | <!-- PASTE --> | `terraform apply tfplan-rebuild` |
| Rebuild completed | <!-- PASTE --> | all resources recreated |
| Verification done | <!-- PASTE --> | ECS 1/1, HTTP 200 |
| **RTO (destroy start → 200)** | **<!-- PASTE: e.g. 42m 17s -->** | wall-clock |

## Pre-destroy resource inventory

### Tagged resources (capstone=tillflow)

<!-- PASTE: output of aws resourcegroupstaggingapi get-resources -->

### ECR images (before destroy)

<!-- PASTE: output of aws ecr list-images for each repo -->

### ECS service task counts (before destroy)

<!-- PASTE: running/desired counts for pos, payments, commission, web, grafana -->

## Destroy plan

<!-- PASTE: terraform plan -destroy summary (resource count line is sufficient) -->

## Destroy apply

<!-- PASTE: terraform apply output (final "Destroy complete! Resources: N destroyed" line) -->

## Rebuild apply

<!-- PASTE: terraform apply output (final "Apply complete! Resources: N added" line) -->

## Post-rebuild outputs

<!-- PASTE: terraform output -->

## Post-rebuild health verification

### ECS service task counts (after rebuild)

<!-- PASTE: running/desired counts for pos, payments, commission, web, grafana — all must be 1/1 -->

### Public endpoint

```
GET https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com/health -> HTTP <!-- PASTE: 200 -->
```

<!-- PASTE: full curl response body -->

## Secrets restoration note

Terraform manages placeholder values for out-of-band secrets
(`lifecycle.ignore_changes = [secret_string]`). After rebuild the following were
re-populated manually via AWS Console / CLI before the health check above:

- Daraja credentials (DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_PASSKEY)
- Grafana admin password
- Slack webhook URL (if configured)

## Reproduce

```bash
export AWS_REGION=eu-west-1
# Review destroy plan first:
./infra/scripts/rebuild.sh --plan-only
# Then execute:
./infra/scripts/rebuild.sh --auto-approve
```
