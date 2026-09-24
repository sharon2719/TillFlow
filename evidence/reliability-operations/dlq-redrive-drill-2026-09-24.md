# G4 DLQ redrive drill
UTC date: 2026-09-24
Owner: sharon2719

## Summary

Live drill against the deployed commission SQS queue and DLQ. Proves:
1. A poison message that the worker cannot process is redelivered up to maxReceiveCount=5
   then moved to the DLQ automatically by SQS.
2. The DLQ can be redriven back to the main queue.
3. A valid message is processed and deleted successfully (no duplicate ledger entry).

Queue: devops-g5-commission-close
DLQ:   devops-g5-commission-close-dlq
maxReceiveCount: 5 (infra/async.tf)

## Step 1 — baseline queue depths
```
devops-g5-commission-close:     ApproximateNumberOfMessages=0
devops-g5-commission-close-dlq: ApproximateNumberOfMessages=0
```

## Step 2 — send poison message
```bash
aws sqs send-message --region eu-west-1 \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/240462142849/devops-g5-commission-close" \
  --message-body '{"action":"","triggeredBy":""}'
```
MessageId: 548f75d2-0f9b-443d-94dc-cd57a76be21e

Body has empty `action` field — worker's `parseTrigger` throws "action is required",
processMessage returns `{ok: false}`, worker logs the error and does NOT delete the message,
leaving it for SQS redelivery.

## Step 3 — worker failure log (5 attempts, one per minute)

```
19:53:08 level=50 messageId=548f75d2 error="action is required" msg="commission worker: failed to process message, leaving for redelivery"
19:54:08 level=50 messageId=548f75d2 error="action is required" msg="commission worker: failed to process message, leaving for redelivery"
19:55:08 level=50 messageId=548f75d2 error="action is required" msg="commission worker: failed to process message, leaving for redelivery"
19:56:08 level=50 messageId=548f75d2 error="action is required" msg="commission worker: failed to process message, leaving for redelivery"
19:57:08 level=50 messageId=548f75d2 error="action is required" msg="commission worker: failed to process message, leaving for redelivery"
```

After the 5th receive SQS moved the message to the DLQ automatically.

## Step 4 — DLQ depth after exhaustion
```
devops-g5-commission-close-dlq: ApproximateNumberOfMessages=1
```

## Step 5 — valid message processed successfully (no duplicate)
```bash
aws sqs send-message --region eu-west-1 \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/240462142849/devops-g5-commission-close" \
  --message-body '{"action":"scheduled-commission-close","triggeredBy":"eventbridge-scheduler"}'
```
MessageId: d3a98979-9ee1-440c-91f5-8296931a7b83

Worker received, inserted into commission.scheduled_runs, deleted from queue.
No duplicate entry (UNIQUE message_id constraint in migration 002_scheduled_runs.sql).

## Step 6 — DLQ redrive
```bash
aws sqs start-message-move-task --region eu-west-1 \
  --source-arn "arn:aws:sqs:eu-west-1:240462142849:devops-g5-commission-close-dlq" \
  --destination-arn "arn:aws:sqs:eu-west-1:240462142849:devops-g5-commission-close"
```
TaskHandle returned — redrive initiated.

## Step 7 — DLQ depth after redrive
```
devops-g5-commission-close-dlq: ApproximateNumberOfMessages=0
```

Message redriven back to main queue. Worker received it again (new MessageId=835ae8d7),
failed again as expected (still a poison message), and will cycle back to DLQ after
5 more receives. This is the correct behavior — the redrive proves the operational
recovery path works; fixing the message content is the operator's responsibility.

## Result

| Phase | Outcome |
|---|---|
| Poison message → 5 worker failures | Confirmed via CloudWatch logs |
| SQS auto-redrive to DLQ after maxReceiveCount=5 | DLQ depth 0→1 confirmed |
| Valid message processed exactly once | Confirmed, no duplicate in scheduled_runs |
| DLQ redrive back to main queue | DLQ depth 1→0 confirmed |

## Reproduce
```bash
QUEUE="https://sqs.eu-west-1.amazonaws.com/240462142849/devops-g5-commission-close"
DLQ="https://sqs.eu-west-1.amazonaws.com/240462142849/devops-g5-commission-close-dlq"

aws sqs send-message --region eu-west-1 --queue-url "$QUEUE" \
  --message-body '{"action":"","triggeredBy":""}'

aws logs tail /devops-g5/commission --follow --region eu-west-1

aws sqs start-message-move-task --region eu-west-1 \
  --source-arn "arn:aws:sqs:eu-west-1:240462142849:devops-g5-commission-close-dlq" \
  --destination-arn "arn:aws:sqs:eu-west-1:240462142849:devops-g5-commission-close"
```
