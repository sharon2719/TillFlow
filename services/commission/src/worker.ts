import { randomUUID } from "node:crypto";

import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import type { Queryable } from "./db.js";
import { logger } from "./logger.js";

export interface SqsMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
}

/**
 * Thin interface over the two SQS calls the worker needs, so tests can drive
 * `runWorkerLoop`/`processMessage` with an in-memory fake instead of a real queue.
 */
export interface SqsLikeClient {
  receiveMessages(queueUrl: string): Promise<SqsMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
}

export function createSqsClient(region: string): SqsLikeClient {
  const client = new SQSClient({ region });
  return {
    async receiveMessages(queueUrl) {
      const res = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20, // long-poll, the AWS-recommended way to avoid empty-receive noise/cost
        }),
      );
      return res.Messages ?? [];
    },
    async deleteMessage(queueUrl, receiptHandle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    },
  };
}

interface ParsedTrigger {
  action: string;
  triggeredBy: string;
}

function parseTrigger(body: string | undefined): ParsedTrigger {
  if (!body) throw new Error("empty message body");
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (typeof parsed.action !== "string" || !parsed.action.trim()) throw new Error("action is required");
  if (typeof parsed.triggeredBy !== "string" || !parsed.triggeredBy.trim()) throw new Error("triggeredBy is required");
  return { action: parsed.action, triggeredBy: parsed.triggeredBy };
}

/**
 * Processes exactly one message: records it in commission.scheduled_runs and reports
 * success/failure. Deliberately NOT the full cross-tenant sales reconciliation - see
 * migrations/002_scheduled_runs.sql for why that's a separate, not-yet-built feature. This
 * function's job is to prove the queue has a real consumer with real success/failure/retry
 * behavior, which is what a recovery drill needs to exist before it can be exercised.
 */
export async function processMessage(
  db: Queryable,
  message: SqsMessage,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!message.MessageId) return { ok: false, error: "message has no MessageId" };
  try {
    const trigger = parseTrigger(message.Body);
    await db.query(
      "INSERT INTO commission.scheduled_runs (id, message_id, action, triggered_by) VALUES ($1, $2, $3, $4)",
      [randomUUID(), message.MessageId, trigger.action, trigger.triggeredBy],
    );
    return { ok: true };
  } catch (err: any) {
    if (err?.code === "23505") {
      // Already recorded this exact message id - SQS's at-least-once delivery redelivered
      // something already processed. Ack it so it doesn't loop forever.
      return { ok: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error processing message" };
  }
}

export interface WorkerOptions {
  queueUrl: string;
  pollIntervalMs?: number;
}

/**
 * Runs until `signal` aborts. A message is only deleted after processMessage succeeds, so a
 * crash mid-processing leaves it to redeliver - and, after 5 receives with no successful
 * delete, redrive to the DLQ (infra/async.tf's redrive_policy). That redelivery/DLQ behavior
 * is exactly what a recovery drill can now kill this process and observe.
 */
export async function runWorkerLoop(
  sqs: SqsLikeClient,
  db: Queryable,
  options: WorkerOptions,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let messages: SqsMessage[];
    try {
      messages = await sqs.receiveMessages(options.queueUrl);
    } catch (err) {
      logger.error({ err }, "commission worker: failed to receive from SQS, retrying next cycle");
      messages = [];
    }

    for (const message of messages) {
      const result = await processMessage(db, message);
      if (result.ok) {
        if (message.ReceiptHandle) {
          try {
            await sqs.deleteMessage(options.queueUrl, message.ReceiptHandle);
          } catch (err) {
            logger.error({ err, messageId: message.MessageId }, "commission worker: failed to delete processed message");
          }
        }
      } else {
        logger.error(
          { messageId: message.MessageId, error: result.error },
          "commission worker: failed to process message, leaving for redelivery",
        );
      }
    }

    if (messages.length === 0 && options.pollIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  }
}
