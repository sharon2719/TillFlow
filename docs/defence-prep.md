# Individual defence prep (G5)

Talking points and exact citations for the live defence, not a script - each section is
"what to say" plus "what to have open" so a question can be answered by pointing at real
proof instead of describing it from memory.

## 1. Design, in one breath

Multi-tenant POS + M-Pesa payments: `web` (BFF) -> API Gateway (VPC Link) -> ALB
(path-routed) -> `pos`/`payments`/`commission` on ECS Fargate, one shared RDS Postgres
(schema-per-service, ADR-0003), Redis + SQS+DLQ+EventBridge for the async side (ADR
implicit in `infra/async.tf`'s own header). Real M-Pesa via `DarajaMpesaAdapter`, a
deterministic `FakeMpesaAdapter` for CI/k6. Full picture: `docs/architecture.md`.

## 2. Trade-offs actually made, and why (have `docs/production-readiness.md` open)

Pick 3-4 of these depending on what's asked - each is a real, disclosed decision, not a gap
that was missed:

- **`desired_count = 1` everywhere, no spare capacity.** Chosen for cost on a training
  account; the real cost of that choice is measured, not hypothetical -
  `docs/recovery-drills.md` drill 1 put a real number on it (~28-40s outage on a killed
  task, self-healed with zero human intervention). `docs/production-readiness.md` records
  this as a decision to revisit "before this ever carries real production traffic," not an
  oversight.
- **AWS-managed KMS key for the alerts SNS topic, not a customer-managed key.** Trivy flags
  this (AWS-0136); accepted anyway (`infra/monitoring.tf`, `trivy:ignore` comment) because a
  CMK key-policy mistake can silently blackhole every alarm email, and the topic only ever
  carries non-sensitive alarm text - the failure mode of the "more secure" option was judged
  worse than the risk it defends against.
- **Single NAT gateway, single-AZ RDS.** Both real cost/complexity trade-offs
  (`docs/production-readiness.md`, `docs/adr/0003-database.md`), both logged as "revisit
  before real traffic," not silently accepted forever.
- **CloudWatch Synthetics couldn't be used at all** - not a choice, a real account-level
  wall (Synthetics needs >=960MB Lambda memory, this account caps Lambda at 512MB, confirmed
  by a real failed `terraform apply`). Pivoted to a plain scheduled Lambda instead. Good
  example of "environmental constraint, disclosed and worked around" vs "gap silently
  ignored" - see `docs/scar-log.md`.

## 3. Your PRs (17 merged, oldest to newest)

`git log --oneline --all --grep="Merge pull request"` for the live list. Grouped by gate:

- **G1** (#1 terraform-foundation, #2 ecs-golden-path, #3 oidc-immutable-id-claim fix, #4
  ci-deploy-apigateway-read fix, #5 readonly-root-filesystem fix, #6 sbom-generation, #7
  terraform-ci-oidc, #8 infra-apply-manual-trigger fix, #14 async-infra)
- **G2** (#9 tenant-setup, #10 Commission, #11 web-bff, #15 daraja-adapter)
- **G3** (#12 g3-operate, #16 g3-completion)
- **G4** (#13 g4-recovery-drill, #17 g4-completion - merged; `feat/g5-completion` covers the
  scar log, evidence pack, cost report and defence prep you're reading right now, and is the
  last PR to land)

Notice the four `fix/*` PRs sitting inside G1 (#3, #4, #5, #8) - real CI failures hit and
fixed during the platform build, not a clean first-try pipeline. That's a fine thing to say
out loud if asked "did everything just work" - no.

## 4. Failure behavior (have `docs/recovery-drills.md` and `docs/scar-log.md` open)

- **Kill the only running task** -> ECS replaces it unprompted in ~28-40s, but the alarms
  configured at the time didn't catch it (two real gaps found and one fixed: the ALB-wide
  5xx alarm added, the 2-minute unhealthy-host window kept deliberately since it's sized to
  not page on routine deploys). Drill 1.
- **A CloudWatch alarm reaching ALARM** -> as of drill 2's 2026-09-18 follow-up,
  **confirmed broken, and isolated to exactly one step**: a direct `sns publish` reaches the
  Slack Lambda in under a second (SNS delivery itself works), but CloudWatch's own alarm
  action never calls `sns:Publish` at all. This is the single most important thing to be
  upfront about if asked "does your alerting work" - the honest answer is "the investigative
  half of the runbook is proven, the delivery half is confirmed broken and pinned down to
  CloudWatch's own action-invocation step, not a policy this repo controls."
- **A Daraja timeout / a replayed callback** -> proven at the unit-test level against real
  response shapes, not live against Daraja's sandbox (see
  `evidence/payments-integrity/money-path-invariants-2026-09-18.md` for exactly why the live
  version wasn't practical - Daraja's sandbox callback delivery couldn't be forced or relied
  on inside a drill window).
- **Redis or the SQS worker going down** -> both now have a real consumer (G4 closed the
  "nothing to break" gap), both designed to degrade rather than crash (pos's auth cache
  falls back to a plain DB query; the SQS worker just leaves an unprocessed message for
  redelivery/DLQ). Whether this has been drilled *live* against deployed infra depends on
  what landed before the defence - check `docs/recovery-drills.md` for the latest drill
  count before claiming it.

## 5. Proof (where to point, not what to say)

- `evidence/reliability-operations/` - the full k6 suite (smoke against real AWS, baseline/
  spike/soak against a local stack, a Daraja contract test against the real deployment).
- `evidence/payments-integrity/` - the real Daraja sandbox verification (including the live
  bug it caught), plus the money-path invariant tests.
- `evidence/product-pos/` - POS's own tenant-isolation/idempotency proof.
- `evidence/platform-delivery/` - the naming/tag audit and the orphaned-resource teardown.
- `docs/capacity-report.md` - the actual bottleneck finding (pos's `desired_count=1`, not
  application code - Runs 2/3 sustain 40+ concurrent VUs locally with single-digit-ms p95,
  so the Run-1 SLO miss against real infra isn't a code problem).

## 6. One cross-system diagnosis, worked end to end

**The pos p95 SLO miss** (`docs/load-tests.md` Run 1, `docs/capacity-report.md`) is the best
one to walk through live, because it's a real multi-step elimination, not a single obvious
fix:

1. **Symptom:** `pos_health_latency` p95 hit 462.9ms against a 400ms target, during a k6
   run hitting all three services' `/health` plus a full business-flow chain, against the
   real deployed stack.
2. **First candidate ruled out - compute saturation.** `aws cloudwatch get-metric-statistics`
   on `AWS/ECS` `CPUUtilization` for `devops-g5-pos` during the exact test window: peaked at
   4.16%. Not CPU-bound.
3. **Second candidate ruled out - the health check itself doing real work.**
   `services/pos/src/health.ts`'s handler is a bare `res.json({status:"ok"})`, byte-for-byte
   the same shape as web/payments/commission's, none of which missed their own targets in
   the same run. The handler isn't the cost.
4. **Working hypothesis, narrowed by elimination, not assumed first:** `pos` is the *only*
   service in that test also serving `business_flow`'s three DB-writing endpoints
   (`POST /tenants`, `/tills`, `/api/v1/sales`) in the same window - same single Node event
   loop, same single Fargate task (`desired_count=1`, no spare capacity). A synchronous
   `hashApiKey` call or an awaited RDS round trip briefly blocking the event loop would
   produce exactly this signature: a p95 tail effect with CPU still idle, not a sustained
   average slowdown.
5. **Cross-checked against a second, independent data source:** Runs 2-3
   (`docs/load-tests.md`) reproduce the *same application code* locally, unconstrained by
   real infra, and sustain 40+ concurrent VUs with p95 in single-digit milliseconds - which
   is what lets `docs/capacity-report.md` conclude the bottleneck is infra capacity
   (`desired_count=1`), not the application logic, instead of guessing.
6. **What's still open, said plainly if asked:** the hypothesis was never confirmed with
   actual per-request server-side profiling (X-Ray span durations) - `docs/load-tests.md`'s
   own follow-ups list this. A good defence answer here is showing the reasoning chain
   above, not claiming the root cause is proven beyond the hypothesis it actually is.

If a second cross-system example is wanted, the **G4 alarm-delivery gap** (drill 2) is the
other real one on hand - a genuinely staged elimination across three services (CloudWatch,
SNS, Lambda): ruled out SNS->Lambda delivery by testing it directly and watching it work,
ruled out a race with the alarm's own evaluation cycle by re-checking within seconds of a
confirmed real `ALARM` state, and landed on a specific, narrow conclusion (CloudWatch's own
action-invocation step is the break) instead of stopping at "alerting might not work."
Whether the underlying AWS-side cause is fixed by the time of the defence, the diagnosis
itself is complete and worth walking through exactly as done above.
