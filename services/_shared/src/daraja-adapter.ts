import { Buffer } from "node:buffer";

import type { B2cRequest, B2cResult, MpesaAdapter, StkPushRequest, StkPushResult, TransactionQueryResult } from "./mpesa-adapter.js";

export interface DarajaConfig {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  initiatorName: string;
  securityCredential: string;
  /** Must be a real, internet-reachable HTTPS URL - Daraja calls back to this. */
  callbackBaseUrl: string;
  /** Defaults to the sandbox host; production Daraja uses api.safaricom.co.ke instead. */
  baseUrl?: string;
}

function darajaTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * Real Safaricom Daraja sandbox integration - the counterpart to FakeMpesaAdapter that
 * CI/k6 run against instead. Endpoint paths and field names match Daraja's published API
 * docs as of this writing. Verification against the live sandbox (OAuth token exchange, a
 * real STK push, a real callback arriving) is tracked in docs/production-readiness.md -
 * this class existing is not the same claim as it being proven correct end to end yet.
 */
export class DarajaMpesaAdapter implements MpesaAdapter {
  private readonly baseUrl: string;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: DarajaConfig) {
    this.baseUrl = config.baseUrl ?? "https://sandbox.safaricom.co.ke";
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }
    const auth = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      throw new Error(`Daraja OAuth token request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: string };
    // Refreshes 60s before actual expiry, not at the wire - avoids a request racing an
    // about-to-expire token.
    this.cachedToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 };
    return body.access_token;
  }

  private password(timestamp: string): string {
    return Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestamp}`).toString("base64");
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    const token = await this.getAccessToken();
    const timestamp = darajaTimestamp();
    const res = await fetch(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: this.password(timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.max(1, Math.round(req.amountMinorUnits / 100)), // Daraja takes whole KES, not minor units
        PartyA: req.msisdn,
        PartyB: this.config.shortcode,
        PhoneNumber: req.msisdn,
        CallBackURL: `${this.config.callbackBaseUrl}/api/v1/payments/callback`,
        AccountReference: req.accountReference,
        TransactionDesc: `TillFlow sale ${req.saleId}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      CheckoutRequestID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
      errorMessage?: string;
    };
    if (res.ok && body.ResponseCode === "0" && body.CheckoutRequestID) {
      return { status: "accepted", checkoutRequestId: body.CheckoutRequestID };
    }
    return {
      status: "rejected",
      reason: body.errorMessage ?? body.ResponseDescription ?? `Daraja returned ${res.status}`,
    };
  }

  async b2c(req: B2cRequest): Promise<B2cResult> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}/mpesa/b2c/v1/paymentrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        InitiatorName: this.config.initiatorName,
        SecurityCredential: this.config.securityCredential,
        CommandID: "BusinessPayment",
        Amount: Math.max(1, Math.round(req.amountMinorUnits / 100)),
        PartyA: this.config.shortcode,
        PartyB: req.msisdn,
        Remarks: "TillFlow commission payout",
        QueueTimeOutURL: `${this.config.callbackBaseUrl}/api/v1/payments/b2c/callback`,
        ResultURL: `${this.config.callbackBaseUrl}/api/v1/payments/b2c/callback`,
        Occasion: req.payoutId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ConversationID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
      errorMessage?: string;
    };
    if (res.ok && body.ResponseCode === "0" && body.ConversationID) {
      return { status: "accepted", conversationId: body.ConversationID };
    }
    return {
      status: "rejected",
      reason: body.errorMessage ?? body.ResponseDescription ?? `Daraja returned ${res.status}`,
    };
  }

  /**
   * STK has a dedicated query endpoint, used below - high confidence, well documented. B2C
   * has no equivalent single call keyed by conversationId; Daraja resolves B2C purely via
   * the ResultURL callback (see payments.ts's /api/v1/payments/b2c/callback). Given a
   * conversationId here (Daraja's real ones don't start "ws_CO_", only CheckoutRequestIDs
   * do), this returns "pending" honestly rather than guessing - a real gap, tracked in
   * docs/production-readiness.md, not a silent wrong answer.
   */
  async queryTransaction(checkoutOrConversationId: string): Promise<TransactionQueryResult> {
    if (!checkoutOrConversationId.startsWith("ws_CO_")) {
      return { status: "pending" };
    }

    const token = await this.getAccessToken();
    const timestamp = darajaTimestamp();
    const res = await fetch(`${this.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: this.password(timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutOrConversationId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ResultCode?: string; ResultDesc?: string };
    if (!res.ok || body.ResultCode === undefined) {
      // Daraja answers with an error (e.g. errorCode 500.001.1001) while the transaction is
      // still being processed - that's "no answer yet", not a real failure.
      return { status: "pending" };
    }
    if (body.ResultCode === "0") {
      return { status: "completed", resultCode: body.ResultCode, resultDescription: body.ResultDesc };
    }
    return { status: "failed", resultCode: body.ResultCode, resultDescription: body.ResultDesc };
  }
}

/** Reads DarajaConfig from the six env vars in services/payments/.env.daraja.example -
 * throws with a clear message naming which one is missing, rather than silently defaulting
 * any of them (a blank consumer secret or callback URL fails in confusing ways much later
 * otherwise). */
export function loadDarajaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DarajaConfig {
  const required = [
    "DARAJA_CONSUMER_KEY",
    "DARAJA_CONSUMER_SECRET",
    "DARAJA_SHORTCODE",
    "DARAJA_PASSKEY",
    "DARAJA_INITIATOR_NAME",
    "DARAJA_SECURITY_CREDENTIAL",
    "DARAJA_CALLBACK_BASE_URL",
  ] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required Daraja env vars: ${missing.join(", ")}`);
  }
  return {
    consumerKey: env.DARAJA_CONSUMER_KEY!,
    consumerSecret: env.DARAJA_CONSUMER_SECRET!,
    shortcode: env.DARAJA_SHORTCODE!,
    passkey: env.DARAJA_PASSKEY!,
    initiatorName: env.DARAJA_INITIATOR_NAME!,
    securityCredential: env.DARAJA_SECURITY_CREDENTIAL!,
    callbackBaseUrl: env.DARAJA_CALLBACK_BASE_URL!,
    baseUrl: env.DARAJA_BASE_URL,
  };
}
