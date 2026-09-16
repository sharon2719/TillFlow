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

## What this confirms

- OAuth token exchange: **verified live**.
- STK push (request shape, response parsing): **verified live**.
- STK query / reconciliation (pending -> real terminal state): **verified live**.

## What's still unverified

- B2C payment request and its result callback.
- The STK result callback (`/api/v1/payments/callback`) receiving a real Daraja-originated
  webhook - this run only exercised the query path, not an inbound callback from Daraja
  itself. That needs the payments service actually deployed and reachable at
  `DARAJA_CALLBACK_BASE_URL` while a real STK push is outstanding.

Tracked as the remaining open item in `docs/production-readiness.md`.
