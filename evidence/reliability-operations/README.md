# Evidence — reliability-operations

This folder contains the operational proof for the load-test and reliability work.

## Included proof

- `k6-smoke-2026-09-16.txt` — real AWS smoke test against the deployed stack
- `k6-baseline-2026-09-17.txt` — local baseline load test under a stepped ramp
- `k6-spike-2026-09-17.txt` — local spike load test output
- `k6-soak-2026-09-17.txt` — local 15-minute soak test output
- `alert-firing-recovery-2026-09-23.txt` — G3 alarm `devops-g5-pos-5xx` fired and recovered; ALARM→OK half confirmed in final alarm history; Lambda dedup log included
- `dlq-redrive-drill-2026-09-24.md` — G4 DLQ redrive drill: poison message → 5 worker failures → DLQ → redrive → DLQ drained

These files are the raw operational evidence used to support the reliability findings and SLO analysis in `docs/load-tests.md` and `docs/capacity-report.md`.
