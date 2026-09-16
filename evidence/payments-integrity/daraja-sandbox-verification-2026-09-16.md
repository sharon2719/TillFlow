# Daraja sandbox verification — 2026-09-16

Live run of `services/payments/scripts/test-daraja-sandbox.ts` against the real Safaricom
Daraja sandbox (`https://sandbox.safaricom.co.ke`), not `FakeMpesaAdapter` and not a mock.
Credentials came from a real Daraja app (Consumer Key/Secret, `Lipa Na M-Pesa Sandbox`
shortcode `174379` + its published passkey, `M-Pesa Sandbox` initiator/security credential),
stored in `services/payments/.env.daraja.local` (gitignored, never committed).

## Run 1 — before shortcode/passkey were set

```
1. OAuth token exchange...
   OK - got a token (length 28, not printed)

2. STK push to the sandbox test number...
   REJECTED: Bad Request - Invalid BusinessShortCode
```

OAuth succeeded on the first real call. The STK rejection was expected - `DARAJA_SHORTCODE`
was still the placeholder `N/A` at this point - and confirms the request actually reached
Daraja and got a real, specific error back, not a network/auth failure.

## Run 2 — after setting the real shortcode (174379) and passkey

```
1. OAuth token exchange...
   OK - got a token (length 28, not printed)

2. STK push to the sandbox test number...
   OK - accepted, checkoutRequestId=ws_CO_160920261839360708374149

3. Querying it back immediately (Daraja usually needs a few seconds)...
   status=pending resultCode=(none yet) resultDescription=(none yet)
```

`ws_CO_...` is a real Daraja CheckoutRequestID - confirms `DarajaMpesaAdapter.stkPush`'s
request shape (BusinessShortCode, Password, Timestamp, PartyA/PartyB, CallBackURL, etc.) was
accepted as valid by the real sandbox.

## Run 3 — querying the same transaction ~15s later

```json
{"status":"failed","resultCode":"1037","resultDescription":"DS timeout user cannot be reached."}
```

Result code 1037 is Daraja's own documented code for "the STK prompt reached the phone but
nothing answered it" - the correct, expected outcome for the sandbox's synthetic test number
(`254708374149`), which has no real device behind it to respond. This is not a bug; it's
proof `DarajaMpesaAdapter.queryTransaction` correctly transitions a real pending transaction
to a real terminal state with Daraja's own result code, exercising the exact "pending -> a
real outcome, not just a canned success" reconciliation path
`docs/production-readiness.md` flagged as unverified.

## Run 4 — a second query hit a real bug: ResultCode 4999 misclassified as failed

A repeat of the push-then-query sequence returned this from Daraja before run 3's later
query caught the real terminal state:

```
status=failed resultCode=4999 resultDescription=The transaction is still under processing
```

**4999 is Daraja's own documented code for "not resolved yet" - the adapter was reporting it
as a real failure.** Two compounding bugs, both real, both fixed in the same pass:

1. `queryTransaction` only special-cased `ResultCode === undefined` as pending; a
   present-but-non-`"0"` code like 4999 fell through to `"failed"`. Fixed: `4999` is now
   explicitly treated as pending.
2. Daraja's `ResultCode` (and, checked defensively at the same time, `ResponseCode` on the
   STK/B2C accept responses) arrives as a **JSON number**, not a string - `body.ResultCode
   === "0"` would never match a real success either, for the same reason. Fixed with
   `String(body.ResultCode)` before any comparison.

This directly threatened the system's own "a timeout is never treated as a decline"
guarantee (`docs/threat-model.md` #2) - the exact failure mode the fake-adapter test suite
already covers for simulated timeouts, now also closed for the real adapter. Locked in with
5 new deterministic unit tests in `services/_shared/test/daraja-adapter.test.ts` (mocked
fetch, not dependent on hitting this exact timing window against the live sandbox again) -
all pass, plus 2 more covering the numeric-`ResponseCode` fix on `stkPush`/`b2c`.

## Run 5 — B2C payout, real acceptance

```
4. B2C payout to the sandbox test number...
   OK - accepted, conversationId=AG_20260916_010010031466x43pb6h6
```

A real Daraja B2C ConversationID (`AG_...` format) came back, using the same shortcode
(`174379`) as `PartyA` - confirms B2C doesn't need a separate test shortcode from STK, and
that `InitiatorName`/`SecurityCredential` were both accepted as valid.

## Run 6 — deployed to real AWS, inbound callback attempted and not observed

With `feat/g2-daraja-adapter` merged and deployed (task definition revision `:5`, all six
Daraja secrets confirmed present via `aws ecs describe-task-definition`), triggered a real
STK push and a real B2C payout directly against the live public endpoint
(`https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com`), both accepted by Daraja with real
IDs. Confirmed the deployed service is genuinely running `DarajaMpesaAdapter` (not the fake -
the returned IDs are real `ws_CO_...`/`AG_...` formats), and `GET /transactions/:id` performed
a real, live `source: "reconciled"` query against Daraja from inside AWS.

**No inbound callback arrived at either `/api/v1/payments/callback` or
`/api/v1/payments/b2c/callback`** within 13+ minutes (STK) / 7+ minutes (B2C) of waiting.
Checked two independent log sources to rule out a routing/rejection problem on our side:

- `services/payments`' own CloudWatch logs (`/devops-g5/payments`): no request to either
  callback path.
- The API Gateway's own access logs (`/devops-g5/api-gateway`), which *did* correctly
  capture every one of the test's own outbound requests (the STK push, the B2C payout, both
  status queries) - confirming logging itself works and nothing reached even the edge for
  either callback path.

This means Daraja's sandbox itself did not deliver a callback in the observed window, not
that one was sent and rejected. Plausible causes: Safaricom's sandbox is documented
elsewhere as sometimes slow or unreliable about callback delivery for the "customer
unreachable" test scenario specifically; it may simply need longer than tested here; or
there's a delivery-side condition not yet identified. Not confirmed which.

## What this confirms

- OAuth token exchange: **verified live**.
- STK push (request shape, response parsing): **verified live**.
- STK query / reconciliation (pending -> real terminal state, including the 4999 "still
  processing" state): **verified live**, after fixing two real bugs it exposed.
- B2C payment request (request shape, response parsing): **verified live**.
- The real adapter is genuinely running in the deployed AWS service, with real credentials
  resolved from Secrets Manager: **verified live**.

## What's still unverified

- Both inbound callback routes actually receiving a real Daraja-originated webhook. Tested
  directly against the live deployed service (not just locally) and not observed within a
  13-minute window - see run 6. Not ruled out as working, just not yet caught in the act.
- The result of a B2C payout specifically - Daraja resolves B2C purely via the callback,
  which `queryTransaction` can't proactively check (see `daraja-adapter.ts`'s own comment on
  why), so this is entirely dependent on the callback landing.

Tracked as the remaining open item in `docs/production-readiness.md`.
