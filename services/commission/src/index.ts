import { app } from "./app.js";
import { createPool } from "./db.js";
import { logger } from "./logger.js";
import { createSqsClient, runWorkerLoop } from "./worker.js";

const port = Number(process.env.PORT ?? 3002);

app.listen(port, () => {
  logger.info({ port }, "commission service listening");
});

// Only started when deployed with a real queue configured (infra/ecs-commission.tf) - local
// dev/tests run the HTTP server alone, same pattern as payments' defaultAdapter fallback.
const queueUrl = process.env.COMMISSION_CLOSE_QUEUE_URL;
if (queueUrl) {
  const controller = new AbortController();
  const sqs = createSqsClient(process.env.AWS_REGION ?? "eu-west-1");
  runWorkerLoop(sqs, createPool(), { queueUrl, pollIntervalMs: 5000 }, controller.signal).catch((err) => {
    logger.error({ err }, "commission worker loop crashed");
  });
  process.on("SIGTERM", () => controller.abort());
  logger.info({ queueUrl }, "commission scheduled-close worker started");
} else {
  logger.warn("COMMISSION_CLOSE_QUEUE_URL not set - scheduled-close worker not started");
}
