# G4 callback replay and reorder drill
UTC date: 2026-09-24
Owner: Gatchang-nyawargak

## Summary

Live drill against the deployed payments service. Proves one legal transition and one
ledger effect regardless of how many times a callback is delivered or in what order.

Payment under test:
- checkoutRequestId: ws_CO_240920262250119716510273
- paymentId: 386dca77-cfa8-49e1-9f81-64d964a3c987
- Final state before drill: completed (resultCode=0, arrived from Daraja at 19:50:23 UTC)

## Drill execution

### Replay 1 — same callback delivered a second time (success)
```bash
curl -s -X POST "$API/api/v1/payments/callback" \
  -H 'content-type: application/json' \
  -d '{
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "replay-test-1",
        "CheckoutRequestID": "ws_CO_240920262250119716510273",
        "ResultCode": 0,
        "ResultDesc": "The service request is processed successfully."
      }
    }
  }'
```
Response:
```json
{"paymentId":"386dca77-cfa8-49e1-9f81-64d964a3c987","status":"completed","note":"already resolved, callback ignored"}
```

### Replay 2 — reordered callback (failure delivered after success)
```bash
curl -s -X POST "$API/api/v1/payments/callback" \
  -H 'content-type: application/json' \
  -d '{
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "replay-test-2",
        "CheckoutRequestID": "ws_CO_240920262250119716510273",
        "ResultCode": 1032,
        "ResultDesc": "Request cancelled by user."
      }
    }
  }'
```
Response:
```json
{"paymentId":"386dca77-cfa8-49e1-9f81-64d964a3c987","status":"completed","note":"already resolved, callback ignored"}
```

### Final state verification
```bash
curl -s "$API/api/v1/payments/transactions/ws_CO_240920262250119716510273"
```
Response:
```json
{"id":"ws_CO_240920262250119716510273","status":"completed","resultCode":"0","resultDescription":"The service request is processed successfully.","source":"local"}
```

## Result

| Attempt | Delivered | DB state after | Ledger effects |
|---|---|---|---|
| 1 (real Daraja callback) | resultCode=0 success | completed | 1 — pending → completed |
| 2 (replay, same success) | resultCode=0 success | completed | 0 — ignored |
| 3 (reorder, failure after success) | resultCode=1032 failure | completed | 0 — ignored |

**One legal transition, one ledger effect.** The state machine check
(`if existing.rows[0].status !== "pending"`) is the enforcement mechanism — any callback
arriving after the first terminal transition is a no-op, regardless of its content.

## Mechanism (services/payments/src/payments.ts)

```typescript
if (existing.rows[0].status !== "pending") {
  res.status(200).json({
    paymentId: existing.rows[0].id,
    status: existing.rows[0].status,
    note: "already resolved, callback ignored"
  });
  return;
}
```
