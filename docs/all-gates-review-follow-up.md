# All-gates review follow-up

This document tracks the current repo status against the capstone gate bar and maps each review item to the artifact or living document that proves it.

## Workstreams

Repo maturity and governance work is implemented: ownership, CODEOWNERS, review mapping,
operational lifecycle scripts, README conventions, and production-readiness governance are
in place. The remaining work is live gate-evidence execution, not additional repo
scaffolding.

Execute the remaining work in this order:

1. DONE: capture, document, and commit G3 alert firing → recovery evidence.
2. DONE: capture, document, and commit the G3 sale/payment/callback trace.
3. DONE: capture, document, and commit the G3 scheduled commission trace.
4. DONE: capture, document, and commit the G4 callback replay/reorder drill.
5. DONE: capture, document, and commit the G4 DLQ redrive drill.
6. Capture, document, and commit the G5 destroy → rebuild run.
7. Perform the final README and documentation status pass.
8. Run a final repo-wide consistency review.

## Gate summary

| Gate | Status | Current evidence | Notes |
|---|---|---|---|
| G0 | PASS | [ownership.md](./ownership.md), [threat-model.md](./threat-model.md), [architecture.md](./architecture.md) | Ownership and defence boundaries are documented. |
| G1 | PASS with fixes | [evidence/platform-delivery](../evidence/platform-delivery), [README.md](../README.md), [infra/ecs-task-def.tf](../infra/ecs-task-def.tf), [infra-apply.yml](../.github/workflows/infra-apply.yml) | ADOT `HEALTHY` ordering and saved-plan apply are reflected in the repo. |
| G2 | PASS | [evidence/payments-integrity](../evidence/payments-integrity) | Money-path invariants and replay-safety evidence are committed. |
| G3 | PASS | [evidence/payments-integrity/sale-payment-callback-trace-2026-09-24.md](../evidence/payments-integrity/sale-payment-callback-trace-2026-09-24.md), [evidence/payments-integrity/commission-trace-2026-09-24.md](../evidence/payments-integrity/commission-trace-2026-09-24.md), [evidence/reliability-operations/alert-firing-recovery-2026-09-23.txt](../evidence/reliability-operations/alert-firing-recovery-2026-09-23.txt) | All three proof items captured live: alert firing/recovery, sale→payment→callback trace, commission trace with B2C. |
| G4 | PASS | [evidence/payments-integrity/callback-replay-reorder-drill-2026-09-24.md](../evidence/payments-integrity/callback-replay-reorder-drill-2026-09-24.md), [evidence/reliability-operations/dlq-redrive-drill-2026-09-24.md](../evidence/reliability-operations/dlq-redrive-drill-2026-09-24.md), [docs/recovery-drills.md](./recovery-drills.md) | Replay/reorder drill and DLQ redrive drill both executed live with timestamped evidence. |
| G5 | Planned execution | [docs/cost-and-teardown.md](./cost-and-teardown.md) | Destroy → rebuild has a written procedure but not a recorded executed run. |

## Review follow-up log

| Review item | Current status | Evidence or owner | Next action |
|---|---|---|---|
| Fix ADOT `dependsOn` to `HEALTHY` | DONE | [infra/ecs-task-def.tf](../infra/ecs-task-def.tf), [infra/ecs-web.tf](../infra/ecs-web.tf) | Keep the task definitions aligned with the documented baseline. |
| Apply the reviewed saved Terraform plan, not a fresh auto-approve apply | DONE | [.github/workflows/infra-apply.yml](../.github/workflows/infra-apply.yml) | Continue to apply the saved plan and record the artifact link in run notes. |
| Alerting path works end-to-end | DONE | [Slack alert capture](../evidence/group-5-slack-alert.png), [docs/recovery-drills.md](./recovery-drills.md), [docs/runbook.md](./runbook.md), [docs/production-readiness.md](./production-readiness.md) | Keep the live alarm → EventBridge → SNS → Lambda → Slack evidence linked; G3 remains open for the separate money-flow traces. |
| Sale/payment/callback trace | DONE | [evidence/payments-integrity/sale-payment-callback-trace-2026-09-24.md](../evidence/payments-integrity/sale-payment-callback-trace-2026-09-24.md) | Live trace captured 2026-09-24: sale→STK push→Daraja callback (11s latency)→completed. |
| Scheduled commission trace | DONE | [evidence/payments-integrity/commission-trace-2026-09-24.md](../evidence/payments-integrity/commission-trace-2026-09-24.md) | Live trace captured 2026-09-24: commission close→B2C call to payments via internal ALB with traceparent propagation. |
| Callback replay/reorder drill | DONE | [evidence/payments-integrity/callback-replay-reorder-drill-2026-09-24.md](../evidence/payments-integrity/callback-replay-reorder-drill-2026-09-24.md) | Live drill 2026-09-24: 3 callbacks (real + replay + reorder), 1 state transition, 0 duplicate ledger effects. |
| DLQ redrive drill | DONE | [evidence/reliability-operations/dlq-redrive-drill-2026-09-24.md](../evidence/reliability-operations/dlq-redrive-drill-2026-09-24.md) | Live drill 2026-09-24: poison message → 5 worker failures → DLQ → redrive → DLQ drained. |
| Destroy → rebuild run | PLANNED | [docs/cost-and-teardown.md](./cost-and-teardown.md) | Schedule, execute, and capture the full rebuild flow. |

## Evidence standards

A gate is considered complete only when the repo contains:

- a dated evidence artifact under `evidence/`;
- a short operational summary in the relevant docs;
- the README or gate doc reflects the actual status;
- the evidence proves the complete requested flow, not just the design.

**Hard rule:** do not mark any gate `PASS` unless the dated evidence file exists in the
repository, is linked from the relevant README or gate document, and proves the complete
requested flow. Capture, document, and commit real evidence under `evidence/` before
changing gate status.

## Ownership

- Platform + delivery: sharon2719
- Payments + integrity: Gatchang-nyawargak
- Reliability + operations: sharon2719
- Product + POS: sharon2719

This review follow-up is intentionally explicit about what is proven today and what is still being executed.
