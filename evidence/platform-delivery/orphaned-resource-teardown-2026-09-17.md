# Orphaned resource teardown — 2026-09-17

In response to the cohort-wide instruction to tear down all active AWS resources except
each group's own assignment: identified and removed a set of resources dated 2026-08-28
that predate this repo, were never managed by `infra/`'s Terraform (confirmed via
`terraform state list`), and weren't referenced by anything in the live TillFlow deployment.
The TillFlow stack itself (VPC, ECS cluster, all five services, RDS, ALB, API Gateway,
Grafana, monitoring) was left untouched and confirmed still healthy after the teardown.

## What was removed

**IAM roles** (confirmed unattached to any current TillFlow role/policy before deletion):
- `devops-g5-iac-ecs-execution-role`
- `devops-g5-iac-ecs-task-role`
- `devops-g5-iac-gha-deploy`

**CloudWatch alarms** (all in `OK` state, unrelated to `infra/monitoring.tf`'s alarms):
- `devops-g5-iac-alb-latency-p95`
- `devops-g5-iac-alb-target-5xx`
- `devops-g5-iac-alb-unhealthy-hosts`
- `devops-g5-iac-greet-failures`
- `devops-g5-iac-service-a-cpu-high`

**ECS task definitions** (discovered during the teardown - not in the original orphaned-
resource list, but the same Aug-28 bundle: they referenced the two orphaned IAM roles above,
and no ECS service in the cluster ran any of them):
- `devops-g5-iac-td-service-a` (revisions 3, 4, 5 - deregistered)
- `devops-g5-iac-td-service-b` (revisions 3, 4, 5 - deregistered)
- `devops-g5-iac-td-service-c` (revisions 3, 4, 5 - deregistered)

## Verification

- Confirmed via `aws ecs list-services --cluster devops-g5` that only the five real TillFlow
  services (`pos`, `payments`, `commission`, `web`, `grafana`) exist as services in the
  cluster - the `-iac-td-service-*` families were registered task definitions with no
  running service.
- Post-teardown: `aws iam list-roles`, `aws cloudwatch describe-alarms`, and
  `aws ecs list-task-definitions` all confirm the orphaned resources are gone.
- Post-teardown: all five TillFlow services confirmed still `running=desired=1`.
