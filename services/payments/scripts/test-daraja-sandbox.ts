/**
 * Standalone connectivity check against the REAL Daraja sandbox - not run in CI, not run
 * by any test suite. Confirms the five credentials in .env.daraja.local actually work
 * before anything depends on them, without ever printing a raw secret.
 *
 * Usage (from the repo root):
 *   cp services/payments/.env.daraja.example services/payments/.env.daraja.local
 *   # fill in real values in .env.daraja.local
 *   npx tsx services/payments/scripts/test-daraja-sandbox.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DarajaMpesaAdapter, loadDarajaConfigFromEnv } from "@tillflow/shared";

/** Loads services/payments/.env.daraja.local into process.env if it exists - deliberately
 * not the `dotenv` package (one more dependency for a script nothing else depends on); this
 * covers the plain KEY=VALUE lines .env.daraja.example actually has. */
function loadLocalEnvFile(): void {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.daraja.local");
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} not found - copy .env.daraja.example to .env.daraja.local and fill in real values`);
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strips one matching pair of surrounding quotes - the security credential is long
    // enough that it's easy to instinctively wrap in quotes, but process.env values are
    // never auto-unquoted the way a shell would do it.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadLocalEnvFile();
  console.log("Loading Daraja config from environment...");
  const config = loadDarajaConfigFromEnv();
  console.log(`  shortcode: ${config.shortcode}`);
  console.log(`  callbackBaseUrl: ${config.callbackBaseUrl}`);
  console.log("  (consumer key/secret/passkey/initiator/security credential loaded but never printed)");

  const adapter = new DarajaMpesaAdapter(config);

  console.log("\n1. OAuth token exchange...");
  // Not part of the public MpesaAdapter interface - reaching into the private method
  // deliberately, this script's only job is to prove the credentials work at all.
  const token = await (adapter as unknown as { getAccessToken(): Promise<string> })["getAccessToken"]();
  console.log(`   OK - got a token (length ${token.length}, not printed)`);

  console.log("\n2. STK push to the sandbox test number...");
  const testMsisdn = process.env.DARAJA_TEST_MSISDN ?? "254708374149"; // Safaricom's documented sandbox test number
  const result = await adapter.stkPush({
    tenantId: "daraja-sandbox-test",
    saleId: "sandbox-test-sale",
    msisdn: testMsisdn,
    amountMinorUnits: 100, // Daraja takes whole KES; this becomes 1 KES
    accountReference: "TillFlowSandboxTest",
    idempotencyKey: `sandbox-test-${Date.now()}`,
  });

  if (result.status === "accepted") {
    console.log(`   OK - accepted, checkoutRequestId=${result.checkoutRequestId}`);
    console.log("\n3. Querying it back immediately (Daraja usually needs a few seconds)...");
    await new Promise((r) => setTimeout(r, 5000));
    const query = await adapter.queryTransaction(result.checkoutRequestId);
    console.log(`   status=${query.status} resultCode=${query.resultCode ?? "(none yet)"} resultDescription=${query.resultDescription ?? "(none yet)"}`);
    console.log("\nAll three calls completed. This confirms OAuth + STK push + STK query work against the real sandbox.");
    console.log("B2C and the two callback endpoints still need their own verification - see docs/production-readiness.md.");
  } else {
    console.log(`   REJECTED: ${result.reason}`);
    console.log("\nOAuth worked (step 1 succeeded) but the STK push itself was rejected - check the reason above.");
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
