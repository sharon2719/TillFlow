// One-minute external synthetic probe (infra/external-probe.tf) - hits the public API
// Gateway endpoint from outside the VPC entirely, the same path a real user's request
// takes (API Gateway -> VPC Link -> ALB -> pos), unlike every other health signal in this
// stack, which observes from inside AWS.
//
// This is a plain scheduled Lambda, not a CloudWatch Synthetics canary - Synthetics
// canaries require a minimum of 960MB of Lambda memory (an AWS API-enforced constraint),
// but this shared cohort account caps every Lambda function's memory at 512MB (a real,
// confirmed CreateFunction rejection, not a guess - see docs/production-readiness.md).
// Those two constraints are mutually exclusive in this account, so Synthetics literally
// cannot run here. This Lambda does the same job Synthetics would have (external HTTP
// check, on a schedule, emitting a signal to alarm on) within the account's real limits.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const cloudwatch = new CloudWatchClient({});

export const handler = async () => {
  const targetUrl = process.env.TARGET_URL;
  const start = Date.now();
  let success = 0;
  let statusCode = null;
  let errorMessage = null;

  try {
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(10_000) });
    statusCode = res.status;
    const body = await res.text();
    success = res.ok && body.includes('"status":"ok"') ? 1 : 0;
    if (!success) {
      errorMessage = `Unexpected response: status=${statusCode} body=${body}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - start;

  if (errorMessage) {
    console.log(`Probe failed: ${errorMessage}`);
  } else {
    console.log(`Probe succeeded: statusCode=${statusCode} latencyMs=${latencyMs}`);
  }

  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "TillFlow/ExternalProbe",
      MetricData: [
        {
          MetricName: "ProbeSuccess",
          Value: success,
          Unit: "None",
          Dimensions: [{ Name: "Target", Value: "pos-health" }],
        },
        {
          MetricName: "ProbeLatencyMs",
          Value: latencyMs,
          Unit: "Milliseconds",
          Dimensions: [{ Name: "Target", Value: "pos-health" }],
        },
      ],
    }),
  );
};
