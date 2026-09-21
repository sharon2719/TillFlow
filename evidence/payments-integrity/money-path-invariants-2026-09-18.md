# Money-path invariants: timeout-is-pending, replay-safety, no-double-pay (G2/G4)

Real test output, run 2026-09-18. Reproduce: `npm run test --workspace=@tillflow/payments`,
`npm run test --workspace=@tillflow/commission`, `npm run test --workspace=@tillflow/shared`.
Raw output: `payments-test-output-2026-09-18.txt`, `commission-test-output-2026-09-18.txt`,
`shared-test-output-2026-09-18.txt` in this directory.

**Result: payments 7/7, commission 12/12, shared 7/7 - all passed.**

These three suites are the actual evidence behind two of G4's required drills. They're
deterministic tests against the real request-handling code (payments' real
`DarajaMpesaAdapter` parsing logic, real HTTP calls between commission and payments - see
`test/commission.test.ts`'s header for why it starts a real in-process Payments server
instead of mocking it), not a live exercise against Daraja's sandbox - see "What a live
version would need" below for why.

## G4 drill: "force a Daraja timeout - stays pending, gets reconciled, a retry can't
double-charge"

- `services/_shared/test/daraja-adapter.test.ts:41` and `:48` - `DarajaMpesaAdapter`
  treats Daraja's real `ResultCode` `4999` ("still processing") as `pending`, both as the
  JSON number Daraja actually sends and as a string, closing the exact bug this pass found
  live against the sandbox (see `evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md`,
  Run 3-4): the original code compared a number against the string `"0"`, so even a genuine
  success would never have matched, and `4999` specifically was misread as a failure.
- `services/payments/test/payments.test.ts:101` - a timeout on the query path (no callback
  ever arrives, `queryTransaction` reports still-pending) leaves the payment `pending`, and
  a retried STK push under the *same* idempotency key does not create a second charge.

## G4 drill: "replay and reorder callbacks - one legal transition, one ledger effect, a
trace explaining the duplicate"

- `services/payments/test/payments.test.ts:154` - sending the same callback twice (a replay)
  or out of the order Daraja would normally deliver them (a reorder) is a no-op the second
  time: one state transition happens, not two, and the second delivery is recognized and
  discarded rather than double-applied.
- `services/commission/test/commission.test.ts:113` - the sharper version of the same
  property one layer up: retrying a commission close for the same sale under a *different*
  idempotency key (not just a replay of the same request) still cannot double-pay, because
  the real backstop is the DB's own `UNIQUE (tenant_id, business_date, sale_id)` index on
  `commission.payouts`, not the idempotency-key check alone.
- `services/commission/test/worker.test.ts:55` - the G4 SQS worker's own version of the same
  property: a redelivered message (SQS's at-least-once delivery can and will redeliver
  after a slow ack) is recognized by its message ID and acked again rather than recorded
  twice.

## What a live version of these two drills would need, and why it wasn't run that way

Forcing a *real* Daraja sandbox timeout on demand isn't something this integration
controls - Safaricom's sandbox either responds or doesn't on its own schedule (see the
sandbox-verification evidence linked above: two independent live attempts each waited
10+ minutes for an inbound callback that Daraja's sandbox never delivered at all, which is
itself the closest thing to a "real" forced-timeout observation this system has produced).
Replaying a callback against the *live* deployed endpoint is possible and safe to do (it's
just an HTTP POST with a real, already-used `CheckoutRequestID`), but doing so doesn't
exercise anything the deterministic test above doesn't already cover more precisely,
since the live endpoint runs the exact same `parseStkCallback`/idempotency code path.
Tracked as an open item if a live version is still wanted before G5 closes - see
`docs/production-readiness.md`.
