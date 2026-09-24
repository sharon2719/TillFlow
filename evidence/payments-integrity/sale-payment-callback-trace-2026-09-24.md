# G3 sale → payment → callback trace
UTC date: 2026-09-24
Owner: Gatchang-nyawargak

## Summary

Full money-path executed live against the deployed stack in eu-west-1.
Phone: 254716510273. Amount: KES 200 (amountMinorUnits: 20000).

| Step | Time (UTC) | Service | Result |
|---|---|---|---|
| POST /tenants | 19:47:56 | pos | 201 tenantId=5127ecf3-c8f9-445a-aaa2-8bfa9506ee1c |
| POST /attendants | 19:48:05 | pos | 201 attendantId=6c1663a7-cdf8-452d-b5b2-bc79a30507d6 |
| POST /tills | 19:48:06 | pos | 201 tillId=4232cec3-2d85-48b5-b49d-ee6e4d0d0c9a commissionRateBps=500 |
| POST /api/v1/sales | 19:48:41 | pos | 201 saleId=77ef1bf1-8459-4f89-8810-ed612d6a7adf totalMinorUnits=20000 |
| POST /api/v1/payments/stk | 19:50:12 | payments | 201 paymentId=386dca77-cfa8-49e1-9f81-64d964a3c987 checkoutRequestId=ws_CO_240920262250119716510273 status=pending |
| POST /api/v1/payments/callback | 19:50:23 | payments | 200 status=completed resultCode=0 (Daraja callback from 196.201.214.200) |
| GET /api/v1/payments/transactions/ws_CO_... | 19:51:43 | payments | 200 status=completed source=local |

**STK push → callback latency: 11 seconds** (19:50:12 → 19:50:23).

## X-Ray trace IDs

| Request | x-amzn-trace-id Root |
|---|---|
| POST /api/v1/payments/stk | 1-6ab57ef2-10c202aa7fb0d29b5b9f470f |
| POST /api/v1/payments/callback (Daraja) | 1-6ab57eff-598dcaef6ed610543ca901a3 |
| GET /api/v1/payments/transactions/... | 1-6ab57f4f-6c650edc000989207f883aaa |

## Key log entries

### POS — sale recorded (19:48:41 UTC)
```
POST /api/v1/sales 201 11ms
x-amzn-trace-id Root=1-6ab57e99-4af1a6907daed9d6026576da
Idempotency-Key: sale-g3-trace-20260924194841
```

### Payments — STK push accepted (19:50:12 UTC)
```
POST /api/v1/payments/stk 201 1393ms
x-amzn-trace-id Root=1-6ab57ef2-10c202aa7fb0d29b5b9f470f
checkoutRequestId: ws_CO_240920262250119716510273
```

### Payments — Daraja callback received (19:50:23 UTC)
```
POST /api/v1/payments/callback 200 58ms
user-agent: ReactorNetty/1.2.9
businessshortcode: 174379
forwarded: for=196.201.214.200 (Daraja IP)
x-amzn-trace-id Root=1-6ab57eff-598dcaef6ed610543ca901a3
resultCode=0 "The service request is processed successfully."
pending → completed (one legal transition)
```

### Payments — reconciliation query (19:51:43 UTC)
```
GET /api/v1/payments/transactions/ws_CO_240920262250119716510273 200 54ms
status=completed source=local
```

## Reproduce
```bash
API="https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com"

# 1. Create tenant
curl -s -X POST "$API/tenants" -H 'content-type: application/json' \
  -d '{"name":"Trace Tenant","ownerName":"Alice","ownerMsisdn":"254712345678"}'

# 2. Record sale (use returned attendant apiKey and tillId)
curl -s -X POST "$API/api/v1/sales" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <attendant-api-key>" \
  -H "Idempotency-Key: sale-$(date +%s)" \
  -d '{"tillId":"<tillId>","items":[{"sku":"ITEM-001","quantity":2,"unitPriceMinorUnits":10000}]}'

# 3. STK push
curl -s -X POST "$API/api/v1/payments/stk" -H 'content-type: application/json' \
  -d '{"tenantId":"<tenantId>","saleId":"<saleId>","msisdn":"254716510273",
       "amountMinorUnits":20000,"accountReference":"<saleId>","idempotencyKey":"stk-<ts>"}'

# 4. Poll status
curl -s "$API/api/v1/payments/transactions/<checkoutRequestId>"
```
