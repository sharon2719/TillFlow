import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

import type { Queryable } from "../src/db.js";
import { processMessage, runWorkerLoop, type SqsLikeClient, type SqsMessage } from "../src/worker.js";

const COMMISSION_MIGRATION_1 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_commission.sql"),
  "utf8",
);
const COMMISSION_MIGRATION_2 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "002_scheduled_runs.sql"),
  "utf8",
);

function createTestDb(): Queryable {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.none(COMMISSION_MIGRATION_1);
  mem.public.none(COMMISSION_MIGRATION_2);
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

function triggerMessage(messageId: string, overrides: Partial<SqsMessage> = {}): SqsMessage {
  return {
    MessageId: messageId,
    ReceiptHandle: `receipt-${messageId}`,
    Body: JSON.stringify({ action: "daily-commission-close", triggeredBy: "eventbridge-scheduler" }),
    ...overrides,
  };
}

describe("processMessage", () => {
  it("records a well-formed trigger message", async () => {
    const db = createTestDb();
    const result = await processMessage(db, triggerMessage("msg-1"));
    expect(result).toEqual({ ok: true });

    const rows = await db.query<{ message_id: string; action: string; triggered_by: string }>(
      "SELECT message_id, action, triggered_by FROM commission.scheduled_runs WHERE message_id = $1",
      ["msg-1"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({
      message_id: "msg-1",
      action: "daily-commission-close",
      triggered_by: "eventbridge-scheduler",
    });
  });

  it("treats a redelivered (already-recorded) message id as success, not a duplicate error", async () => {
    const db = createTestDb();
    await processMessage(db, triggerMessage("msg-2"));
    const second = await processMessage(db, triggerMessage("msg-2"));
    expect(second).toEqual({ ok: true });

    const rows = await db.query("SELECT * FROM commission.scheduled_runs WHERE message_id = $1", ["msg-2"]);
    expect(rows.rows).toHaveLength(1); // still exactly one row - not double-recorded
  });

  it("fails a message with no MessageId", async () => {
    const db = createTestDb();
    const result = await processMessage(db, { Body: "{}" });
    expect(result).toEqual({ ok: false, error: "message has no MessageId" });
  });

  it("fails a message with an invalid body instead of crashing", async () => {
    const db = createTestDb();
    const result = await processMessage(db, triggerMessage("msg-3", { Body: "not json" }));
    expect(result.ok).toBe(false);
  });

  it("fails a message missing the required action field", async () => {
    const db = createTestDb();
    const result = await processMessage(db, triggerMessage("msg-4", { Body: JSON.stringify({ triggeredBy: "x" }) }));
    expect(result.ok).toBe(false);
  });
});

/** A queue-in-a-box: lets tests drive runWorkerLoop without a real SQS connection. */
function createFakeQueue(initialMessages: SqsMessage[]): {
  sqs: SqsLikeClient;
  deleted: string[];
  remaining: () => SqsMessage[];
} {
  let queue = [...initialMessages];
  const deleted: string[] = [];
  const sqs: SqsLikeClient = {
    async receiveMessages() {
      const batch = queue;
      queue = [];
      return batch;
    },
    async deleteMessage(_queueUrl, receiptHandle) {
      deleted.push(receiptHandle);
    },
  };
  return { sqs, deleted, remaining: () => queue };
}

describe("runWorkerLoop", () => {
  it("processes and deletes a well-formed message, then stops when aborted", async () => {
    const db = createTestDb();
    const { sqs, deleted } = createFakeQueue([triggerMessage("loop-1")]);
    const controller = new AbortController();

    // pollIntervalMs forces a real setTimeout yield once the fake queue empties - without
    // one, an all-microtask loop (this fake resolves instantly, no real I/O) can starve the
    // timer queue and never let the abort() below actually fire.
    const loopPromise = runWorkerLoop(sqs, db, { queueUrl: "https://example/queue", pollIntervalMs: 5 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await loopPromise;

    expect(deleted).toEqual(["receipt-loop-1"]);
    const rows = await db.query("SELECT * FROM commission.scheduled_runs WHERE message_id = $1", ["loop-1"]);
    expect(rows.rows).toHaveLength(1);
  });

  it("does not delete a message that failed to process, leaving it for redelivery/DLQ", async () => {
    const db = createTestDb();
    const { sqs, deleted } = createFakeQueue([triggerMessage("loop-2", { Body: "not json" })]);
    const controller = new AbortController();

    const loopPromise = runWorkerLoop(sqs, db, { queueUrl: "https://example/queue", pollIntervalMs: 5 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await loopPromise;

    expect(deleted).toEqual([]); // never acked - SQS's visibility timeout will redeliver it
    const rows = await db.query("SELECT * FROM commission.scheduled_runs WHERE message_id = $1", ["loop-2"]);
    expect(rows.rows).toHaveLength(0);
  });
});
