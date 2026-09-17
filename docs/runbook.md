# Runbook

On-call reference for the alarms in `infra/monitoring.tf`. If you're reading this because a
page fired, start with "First response" for that alarm, not the whole document.

Dashboard: `terraform output dashboard_url` (or AWS Console → CloudWatch → Dashboards →
`devops-g5-overview`). Grafana: `https://<api endpoint>/grafana/d/tillflow-overview` (admin
password in Secrets Manager, see `infra/ecs-grafana.tf`). Alarms notify the
`devops-g5-alerts` SNS topic - email (working) and Slack (`infra/slack-notifier.tf`, only
active once a real webhook URL is populated - see `docs/production-readiness.md`). The
Slack message follows a fixed contract per alarm: environment, service, symptom, impact,
value, panel link, runbook link, owner, first safe action - see
`infra/lambda/slack-notifier/index.mjs` for exactly how each alarm maps to those fields.

See `docs/recovery-drills.md` for what's actually been tested against this stack. It found
two gaps: a missing ELB-wide 5xx alarm (fixed below, `alb-elb-5xx`) and a task replacement
fast enough to self-heal in under ~2 minutes (true of every routine deploy, and was also
true of the drill's real killed task) still pages no one at all - that second one is still
open, see `docs/production-readiness.md`.

## What these alarms are (and aren't)

They're built on ALB and RDS metrics - real signals CloudWatch already collects, not the
exact SLI numerators in `docs/slo-error-budgets.md` (e.g. "valid sale writes accepted
exactly once"). Getting the exact numerators would mean each service emitting its own
success/failure/latency metrics per business operation, which none of them do yet - tracked
as a gap in `docs/production-readiness.md`, not silently assumed done. Until that lands,
these alarms answer "is the API up and responding reasonably fast", which is most of what
actually pages someone in practice.

## `<service>-5xx`

**Means:** the ALB's target group for that service returned at least one 5xx in a 5-minute
window.

**First response:**
1. Check the dashboard's "5xx count by service" panel - is it one blip or sustained?
2. Check that service's CloudWatch log group (`/devops-g5/<service>`) for the actual error -
   `aws logs tail /devops-g5/<service> --since 15m --follow`.
3. Check `aws ecs describe-services --cluster devops-g5 --services devops-g5-<service>` -
   is `runningCount` still equal to `desiredCount`? A recent deploy that failed its circuit
   breaker rolls back automatically, but check `deployments[].rolloutState` to confirm.
4. If it's payments/commission specifically: check whether the error originated from a
   downstream call (commission calling payments, or payments calling the fake/real Daraja
   adapter) before assuming the service itself is broken - see `docs/threat-model.md` #1 for
   what's and isn't verified about inbound Daraja callbacks today.

## `alb-elb-5xx`

**Means:** the ALB itself returned a 5xx (`HTTPCode_ELB_5XX_Count`) - distinct from a
target actually responding with one. The most common cause is a target group with zero
healthy targets: the ALB has nowhere to route the request, so it answers with a 503 on the
ALB's own behalf. This is exactly what `docs/recovery-drills.md`'s drill 1 found no alarm
for before this one existed.

**First response:**
1. Check the dashboard's "5xx count by service" panel - the new "ALB itself" line is
   load-balancer-wide, not per-service, so cross-reference each service's own healthy-host
   count on the same dashboard to identify which target group actually had zero healthy
   targets.
2. Follow `<service>-unhealthy`'s first response for that service.
3. If this fires during a deploy window: expected, self-resolving, and part of the accepted
   tradeoff of `desired_count = 1` (see `docs/production-readiness.md`) - confirm the
   deploy's circuit breaker didn't roll back, then let it clear.

## `external-probe-failing`

**Means:** the one-minute external probe (`infra/external-probe.tf`) failed 3 consecutive
checks from *outside* the VPC entirely - the only signal in this stack that observes the
system the same way a real user's browser would, through the public API Gateway endpoint.
Everything else here (the other alarms, the dashboard) observes from inside AWS.

**First response:**
1. Check `/aws/lambda/devops-g5-external-probe`'s own logs for the actual failure (a
   non-200 status, a timeout, or a network error reaching the endpoint at all).
2. If every other alarm is `OK`: this may point at something outside AWS's own visibility -
   API Gateway itself, DNS, or a networking issue between the public internet and API
   Gateway, not the ECS services behind it.
3. Confirm by hitting the public endpoint directly yourself:
   `curl https://<api endpoint>/health` - if that also fails while internal checks are
   green, the problem is specifically in the public-facing path.

## `<service>-latency-p95`

**Means:** p95 response time through the ALB is over that service's SLO target (pos 400ms,
web 500ms) or a generic health threshold (payments/commission 2s - see `infra/monitoring.tf`
for why those two don't have a real SLO-derived number yet).

**First response:**
1. Check RDS CPU/connections on the dashboard - pos, payments, and commission all share one
   RDS instance; a slow query in one shows up as latency in all three.
2. Check ECS task CPU/memory (CloudWatch Container Insights isn't enabled yet - use
   `aws ecs describe-tasks` or the ADOT-fed X-Ray traces for per-request timing).
3. If sustained and RDS/ECS both look healthy, it may be genuine load - the current
   `desired_count = 1` per service has no headroom; scaling out is a G3/G4 follow-up, not
   yet automated.

## `<service>-unhealthy`

**Means:** the target group has 0 healthy targets for 2 consecutive minutes. Because
`desired_count` is 1 everywhere, a normal rolling deploy briefly shows this for under a
minute - the 2-minute window is there specifically so a routine release doesn't page
anyone; if it fires, the deploy is stuck or the task is crash-looping.

**First response:**
1. `aws ecs describe-services --cluster devops-g5 --services devops-g5-<service>` - look at
   `events` for the actual failure reason (image pull failure, health check failing, task
   crashing on startup).
2. `aws logs tail /devops-g5/<service> --since 15m` for the container's own logs.
3. If a bad deploy is the cause: the deploy pipeline's own `deployment_circuit_breaker` (see
   `infra/ecs-*.tf`) should already have rolled it back automatically - confirm the running
   task definition revision matches the last known-good one from
   `.github/workflows/deploy-<service>.yml`'s history.

## `<service>-fast-burn` / `<service>-slow-burn`

**Means:** the error-rate burn rate (observed error rate ÷ the SLO's error budget, see
`docs/slo-error-budgets.md`) crossed 14.4x (fast) or 3x (slow) over `infra/burn-rate-alerts.tf`'s
windows. Same proxy-metric caveat as every alarm in this stack (`docs/production-readiness.md`) -
commission's is the roughest proxy of the four, since its real SLI isn't HTTP-shaped.

**First response:**
1. `fast-burn`: follow `docs/release-freeze-policy.md` - freeze non-emergency deploys to
   this service, then treat it like `<service>-5xx` above (it's the same underlying
   signal, just expressed as a rate against the budget instead of a raw count).
2. `slow-burn`: no freeze needed - ticket it for the next normal deploy per
   `docs/release-freeze-policy.md`.

## `rds-cpu` / `rds-connections` / `rds-free-storage`

**Means:** the single shared RDS instance (pos, payments, and commission's schemas all live
on it - `docs/adr/0003-database.md`) is under CPU/connection/storage pressure.

**First response:**
1. `rds-connections`: check which service's connection pool is misbehaving -
   `pg.Pool`'s default max size per service, times three services, times however many tasks
   are running, is the ceiling; a leak in one service can exhaust it for all three.
2. `rds-cpu`: check for a runaway query - no slow-query log is wired up yet (tracked gap,
   see `docs/production-readiness.md`); in the meantime, correlate the spike's timing
   against each service's request-rate panel on the dashboard.
3. `rds-free-storage`: `allocated_storage = 20` GB with no autoscaling configured yet - if
   this fires, either the database is being asked to hold more than expected, or something
   is writing gratuitously (check migration history isn't re-running unexpectedly).

## Escalation

This is a two-person capstone project (`docs/ownership.md`), not a 24/7 operation - there is
no secondary on-call. If you can't resolve it from this runbook, the honest next step is:
leave the alarm firing, note what you tried, and pick it up when the other owner is
available.
