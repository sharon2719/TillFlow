// Subscribed to the alerts SNS topic (infra/monitoring.tf) - reformats every alarm
// notification into the structured Slack contract the brief asks for (environment, service,
// symptom, impact, value, panel, runbook link, owner, first safe action) before posting to
// the webhook URL in Secrets Manager. AWS Lambda's Node 22 runtime ships the AWS SDK v3
// pre-installed, so this needs no bundled node_modules - the zip is just this one file.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import https from "node:https";

const secretsClient = new SecretsManagerClient({});
const dynamoClient = new DynamoDBClient({});

// Duplicate deliveries here are neither "SNS redelivering the same message" (ruled out
// live: a single isolated alarm transition produced two genuinely distinct SNS MessageIds,
// each successfully claimed against a raw-content hash - so that wasn't it either) nor even
// a single delivery mechanism retrying. Captured and compared the two raw message bodies
// directly: CloudWatch's own NATIVE alarm-to-SNS action turns out to still work on this
// account - just unreliably/with enough delay that every earlier short, deliberate test
// window (docs/recovery-drills.md drill 2) missed it - while infra/alarm-eventbridge-
// bridge.tf's independent rule ALSO delivers. Both fire for the same real transition, each
// producing SNS messages with genuinely different JSON shapes (CloudWatch's native format
// carries AlarmArn/Trigger/OKActions/etc; the EventBridge bridge's input-transformed one is
// a minimal 3-field object) - so a raw-content hash can never match between them. The
// semantic fields both shapes carry (AlarmName/NewStateValue/NewStateReason) are identical
// either way, so the dedup key has to be computed AFTER parsing, not from the raw body.
async function claimMessage(alarmName, newStateValue, newStateReason) {
  const contentHash = createHash("sha256").update(`${alarmName}\u0000${newStateValue}\u0000${newStateReason}`).digest("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1h TTL - duplicates arrive within seconds in practice
  try {
    await dynamoClient.send(
      new PutItemCommand({
        TableName: process.env.DEDUP_TABLE_NAME,
        Item: { contentHash: { S: contentHash }, expiresAt: { N: String(expiresAt) } },
        ConditionExpression: "attribute_not_exists(contentHash)",
      }),
    );
    return true; // first time seeing this exact content - proceed
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false; // already claimed by an earlier delivery of the same content - a duplicate
    }
    // Any other failure (e.g. DynamoDB unavailable): fail open rather than silently drop a
    // real alert - a rare double-post is a much smaller problem than a missed one.
    console.log(JSON.stringify({ msg: "dedup check failed, proceeding anyway (fail open)", error: String(err) }));
    return true;
  }
}

// Keyed by the alarm-name suffix (see infra/monitoring.tf and infra/burn-rate-alerts.tf for
// the actual names) - covers every alarm kind that exists today. An alarm added later that
// doesn't match anything here still gets a real Slack message, just with the generic
// fallback below instead of a tailored one.
const ALARM_KINDS = {
  "5xx": {
    symptom: "Elevated 5xx error rate",
    impact: "Some requests to this service are failing",
    firstSafeAction: "Check the dashboard panel, then this service's CloudWatch logs - see docs/runbook.md",
  },
  "latency-p95": {
    symptom: "p95 latency over its SLO target",
    impact: "Requests are slower than the promised target",
    firstSafeAction: "Check RDS CPU/connections and ECS task CPU/memory - see docs/runbook.md",
  },
  unhealthy: {
    symptom: "No healthy targets behind the ALB",
    impact: "This service may be fully or partially unreachable",
    firstSafeAction: "Check `aws ecs describe-services` events for this service - see docs/runbook.md",
  },
  "fast-burn": {
    symptom: "Fast error-budget burn (>= 14.4x the target rate)",
    impact: "At this rate the 28-day error budget is exhausted in under 2 days",
    firstSafeAction: "Freeze non-emergency deploys to this service - see docs/release-freeze-policy.md",
  },
  "slow-burn": {
    symptom: "Slow error-budget burn (>= 3x the target rate)",
    impact: "Budget is being consumed faster than target, but there's real time to fix it",
    firstSafeAction: "Ticket it for the next normal deploy - no freeze needed, see docs/release-freeze-policy.md",
  },
  "rds-cpu": {
    symptom: "RDS CPU over 80% for 15 minutes",
    impact: "The shared database behind pos/payments/commission may slow all three down",
    firstSafeAction: "Correlate the spike against each service's request-rate panel - see docs/runbook.md",
  },
  "rds-connections": {
    symptom: "RDS connection count unusually high for db.t4g.micro",
    impact: "Risk of exhausting the connection pool shared by pos/payments/commission",
    firstSafeAction: "Check which service's pool is misbehaving - see docs/runbook.md",
  },
  "rds-free-storage": {
    symptom: "RDS free storage below 2GB of 20GB allocated",
    impact: "Risk of the database refusing writes if it fills up",
    firstSafeAction: "Check recent write volume and migration history - see docs/runbook.md",
  },
  "alb-elb-5xx": {
    symptom: "The ALB itself returned a 5xx (no healthy target for some service)",
    impact: "A service was briefly unreachable at the load balancer level",
    firstSafeAction: "Check which target group had zero healthy hosts - see docs/runbook.md",
  },
  "external-probe-failing": {
    symptom: "The external synthetic probe has failed 3 consecutive minutes",
    impact: "The public endpoint may be unreachable from outside AWS, not just internally",
    firstSafeAction: "Check the probe's own CloudWatch logs (/aws/lambda/devops-g5-external-probe) and hit the public endpoint directly - see docs/runbook.md",
  },
};

const SERVICE_OWNERS = {
  pos: "sharon2719",
  web: "sharon2719",
  platform: "sharon2719",
  payments: "Gatchang-nyawargak",
  commission: "Gatchang-nyawargak",
};

// Longest suffix first: "alb-elb-5xx" must win over the shorter "5xx" it also ends with, or
// every alb-elb-5xx alarm gets misclassified as a generic per-service 5xx with the wrong
// service name extracted (caught by testing this against real alarm names before deploy).
const ALARM_KIND_ENTRIES = Object.entries(ALARM_KINDS).sort((a, b) => b[0].length - a[0].length);

function classify(alarmName) {
  const withoutPrefix = alarmName.replace(/^devops-g5-/, "");
  for (const [suffix, info] of ALARM_KIND_ENTRIES) {
    if (withoutPrefix.endsWith(suffix)) {
      const service = withoutPrefix.slice(0, withoutPrefix.length - suffix.length).replace(/-$/, "") || "platform";
      return { service, ...info };
    }
  }
  return {
    service: "platform",
    symptom: "Unrecognized alarm (not in this Lambda's lookup table yet)",
    impact: "Unknown - check the alarm directly in CloudWatch",
    firstSafeAction: "Check docs/runbook.md and the CloudWatch console for this alarm's details",
  };
}

function postToSlack(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export const handler = async (event) => {
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SLACK_WEBHOOK_SECRET_ARN }));
  const webhookUrl = secret.SecretString;

  if (!webhookUrl || webhookUrl === "unset") {
    // Real state until a real Slack webhook is populated (see docs/production-readiness.md) -
    // the alarm still reached SNS/email either way, this Lambda just can't post to Slack yet.
    console.log("SLACK_WEBHOOK_URL is still the placeholder - skipping Slack post for this alarm");
    return;
  }

  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);

    const isNew = await claimMessage(message.AlarmName, message.NewStateValue, message.NewStateReason);
    if (!isNew) {
      console.log(JSON.stringify({ msg: "duplicate alert (same alarm/state/reason via a different delivery path), skipping Slack post", messageId: record.Sns.MessageId }));
      continue;
    }

    const { service, symptom, impact, firstSafeAction } = classify(message.AlarmName);
    const owner = SERVICE_OWNERS[service] ?? "sharon2719";
    const emoji = message.NewStateValue === "ALARM" ? "🔴" : "🟢";

    const text = [
      `${emoji} *${message.AlarmName}* — ${message.NewStateValue}`,
      `*Environment:* ${process.env.ENVIRONMENT_NAME}`,
      `*Service:* ${service}`,
      `*Symptom:* ${symptom}`,
      `*Impact:* ${impact}`,
      `*Value:* ${message.NewStateReason}`,
      `*Panel:* ${process.env.DASHBOARD_URL}`,
      `*Runbook:* ${process.env.RUNBOOK_URL}`,
      `*Owner:* ${owner}`,
      `*First safe action:* ${firstSafeAction}`,
    ].join("\n");

    await postToSlack(webhookUrl, { text });
  }
};
