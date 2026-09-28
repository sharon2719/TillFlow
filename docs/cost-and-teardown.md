# Cost and tear-down/rebuild (G5)

## Cost, from real AWS Cost Explorer data (not an estimate)

Pulled 2026-09-18 via `aws ce get-cost-and-usage`. Two honest caveats up front:

1. **This AWS account is shared** with pre-existing resources that predate this repo (the
   same ones `evidence/platform-delivery/orphaned-resource-teardown-2026-09-17.md` found and
   removed on 09-17). Daily cost was already ~$30/day from 2026-09-02 through 09-10, *before*
   G0 (decide day, 09-11) or any TillFlow infrastructure existed - that baseline is not
   TillFlow's cost.
2. **Per-resource tag-based cost attribution isn't available**: filtering Cost Explorer by
   `capstone=tillflow` returns `$0`, because cost-allocation tags need to be explicitly
   activated in Billing settings (a one-time account setting, not something Terraform
   controls) and that wasn't done. The estimate below is a before/after comparison instead,
   which is the best attribution available without that setting.

**Daily total cost, 2026-09-01 through 09-17:**

| Date | Daily cost | Note |
|---|---|---|
| 09-02 to 09-10 | ~$30.08/day, flat | pre-existing account baseline, not TillFlow |
| 09-11 (G0) | $32.03 | decide-only day, no infra yet |
| 09-13 (G1 starts) | $48.03 | VPC/ECS/RDS/ElastiCache/SQS provisioned |
| 09-15 (G2 due) | $71.54 | payments/commission/pos features live |
| 09-16 (G3 due) | $80.12 | Grafana, burn-rate alarms, external probe added |
| 09-17 (G4 due) | $78.37 | (see per-service breakdown below) |

**TillFlow's own attributable cost: roughly $48/day at full G1-G4 build-out**
(~$78/day on 09-17 minus the ~$30/day pre-existing baseline), not the raw account total.

**09-17 per-service breakdown** (top drivers, real dollars for that one day):

| Service | Cost | What it is |
|---|---|---|
| Amazon VPC | $20.27 | NAT gateway (single NAT, `docs/production-readiness.md`'s disclosed trade-off) + VPC endpoints |
| Amazon ECS | $17.22 | Fargate compute across all 5 services (pos, payments, commission, web, grafana) |
| EC2 - Other | $13.94 | EBS/data-transfer-adjacent charges bundled under this category |
| CloudWatch | $10.00 | Alarms, dashboards, Logs, Container Insights-adjacent metrics |
| RDS | $6.23 | Single db instance, single-AZ (disclosed trade-off, ADR-0003) |
| ALB | $6.56 | The one internal ALB all 5 services share |
| ElastiCache | $2.12 | Single-node Redis (G4's auth cache) |
| X-Ray | $0.92 | Trace ingestion from the ADOT sidecars |
| Secrets Manager | $0.44 | DB credential + Daraja + Slack + Grafana admin secrets |
| KMS | $0.28 | SNS topic key + artifacts bucket key |
| WAF | $0.27 | **Not TillFlow's** - `infra/*.tf` has no `aws_wafv2`/`aws_waf` resource at all, confirmed by grep. This charge belongs to something else in the shared account, same shape as the pre-existing baseline above. |

**What would meaningfully reduce this**, if asked: `desired_count=1` already minimizes
Fargate cost at the expense of the headroom `docs/recovery-drills.md` drill 1 measured; the
single NAT gateway is the next-largest lever (a second, one per AZ, would roughly double
that line for real redundancy); ElastiCache and RDS are both already the smallest available
node classes.

## Tear-down / rebuild via `terraform destroy` + reapply

**Status: ready to execute.** The script and evidence template are in place.
See `evidence/platform-delivery/g5-destroy-rebuild-TEMPLATE.md` for the evidence
template to fill in after the run.

The caution documented here on 2026-09-21 was justified: a smaller `terraform apply`
that day chained into three compounding incidents (`docs/scar-log.md`). The full
destroy + reapply is that same class of risk at maximum scale. Run it with someone
actively watching each step.

**Procedure (automated by `infra/scripts/rebuild.sh`):**

```bash
export AWS_REGION=eu-west-1
# 1. Review the destroy plan first — no changes applied:
./infra/scripts/rebuild.sh --plan-only
# 2. Execute the full run after reviewing the plan:
./infra/scripts/rebuild.sh --auto-approve
```

The script runs these steps and tees all output to a dated log under `evidence/platform-delivery/`:

1. Pre-destroy inventory: `aws resourcegroupstaggingapi get-resources` + ECR image list,
   so there is a real "what existed" snapshot to diff against after reapply.
2. `terraform plan -destroy` — reviewed, not blind.
3. `terraform apply tfplan-destroy`.
4. `terraform apply tfplan-rebuild` — reconstructs all resources from code.
5. Post-rebuild ECS task count check (all five services must reach 1/1).
6. Public endpoint health check (`GET /health` must return HTTP 200).
7. RTO recorded as wall-clock time from destroy start to first 200.

**After the run:** re-populate out-of-band secrets (Daraja credentials, Grafana admin
password, Slack webhook) — Terraform manages placeholders only
(`lifecycle.ignore_changes = [secret_string]`), so a fresh apply does not restore them.
Then fill in `evidence/platform-delivery/g5-destroy-rebuild-TEMPLATE.md`, rename it
with the run date, and commit it. That committed file is the G5 gate evidence.
