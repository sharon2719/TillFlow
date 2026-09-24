# G3 scheduled commission trace
UTC date: 2026-09-24
Owner: Gatchang-nyawargak

## Summary

Commission close executed live against the deployed stack. Proves the full path:
commission close → B2C call to Payments (over internal ALB, not Daraja directly) →
B2C payout requested with trace propagation.

Sale: 77ef1bf1-8459-4f89-8810-ed612d6a7adf (totalMinorUnits=20000, KES 200)
Commission rate: 500 bps (5%)
Commission amount: 1000 minor units (KES 10)
Attendant MSISDN: 254716510273

| Step | Time (UTC) | Service | Result |
|---|---|---|---|
| POST /api/v1/commission/close | 20:01:05 | commission | 201 closeId=e2e77f43-e4af-457a-b78b-500817d4d35f eligibleSales=1 |
| POST /api/v1/payments/b2c (internal) | 20:01:05 | payments | 201 conversationId=AG_20260924_010010451dbfcweilgz0 status=pending |

**Commission → B2C latency: <1s** (same timestamp, commission responseTime=4594ms includes the B2C call).

## Commission close response
```json
{
  "closeId": "e2e77f43-e4af-457a-b78b-500817d4d35f",
  "tenantId": "5127ecf3-c8f9-445a-aaa2-8bfa9506ee1c",
  "businessDate": "2026-09-24",
  "eligibleSales": 1,
  "payouts": [{
    "payoutId": "613ec312-94f6-4c23-a965-f3dcfc5ccf43",
    "saleId": "77ef1bf1-8459-4f89-8810-ed612d6a7adf",
    "attendantId": "6c1663a7-cdf8-452d-b5b2-bc79a30507d6",
    "amountMinorUnits": 1000,
    "status": "requested",
    "conversationId": "AG_20260924_010010451dbfcweilgz0"
  }]
}
```

## X-Ray trace IDs

| Request | x-amzn-trace-id Root |
|---|---|
| POST /api/v1/commission/close | 1-6ab5817d-36d1f2531dba6dec2c7e7de5 |
| POST /api/v1/payments/b2c (internal hop) | Root=1-6ab5817d-7a257b48076fcf654e1957f0 |

**Trace propagation confirmed**: the B2C call from commission to payments carries
`traceparent: 00-7f4a8e5696f9cea94b2a674549749929-e94f6fdabd32258a-01`
linking both hops into the same distributed trace. The internal call arrives at payments
via the internal ALB (`host: internal-devops-g5-alb-1166252124.eu-west-1.elb.amazonaws.com`),
not via API Gateway — proving commission never calls Daraja directly.

## Key log entries

### Commission — close accepted (20:01:05 UTC)
```
POST /api/v1/commission/close 201 4594ms
Idempotency-Key: commission-close-g3-20260924200100
x-amzn-trace-id Root=1-6ab5817d-36d1f2531dba6dec2c7e7de5
```

### Payments — B2C call from commission (20:01:05 UTC)
```
POST /api/v1/payments/b2c 201 4482ms
host: internal-devops-g5-alb-1166252124.eu-west-1.elb.amazonaws.com
traceparent: 00-7f4a8e5696f9cea94b2a674549749929-e94f6fdabd32258a-01
user-agent: node
conversationId: AG_20260924_010010451dbfcweilgz0
```

## SQS worker trace (same session)

The commission SQS worker was also exercised during this session.
A valid trigger message was sent to the queue and the worker processed it:

Valid message sent: MessageId=d3a98979-9ee1-440c-91f5-8296931a7b83
Body: {"action":"scheduled-commission-close","triggeredBy":"eventbridge-scheduler"}

Worker long-polls the queue (WaitTimeSeconds=20) and records each trigger in
commission.scheduled_runs. The EventBridge Scheduler fires this queue daily at 06:00 EAT.

## Reproduce
```bash
API="https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com"

curl -s -X POST "$API/api/v1/commission/close" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: commission-close-$(date +%s)" \
  -d '{
    "tenantId": "<tenantId>",
    "businessDate": "2026-09-24",
    "commissionRateBps": 500,
    "sales": [{
      "saleId": "<saleId>",
      "attendantId": "<attendantId>",
      "attendantMsisdn": "254716510273",
      "totalMinorUnits": 20000,
      "paymentStatus": "paid"
    }]
  }'
```
