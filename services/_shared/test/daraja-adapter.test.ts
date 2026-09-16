import { beforeEach, describe, expect, it, vi } from "vitest";

import { DarajaMpesaAdapter } from "../src/daraja-adapter.js";

const CONFIG = {
  consumerKey: "test-key",
  consumerSecret: "test-secret",
  shortcode: "174379",
  passkey: "test-passkey",
  initiatorName: "TillFlow",
  securityCredential: "test-credential",
  callbackBaseUrl: "https://example.test",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Regression coverage for a bug caught by live testing against the real Daraja sandbox
 * (evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md), not written
 * speculatively: a real STK query response returned ResultCode 4999 ("The transaction is
 * still under processing") as a JSON *number*, which the original code neither special-cased
 * as pending nor coerced to a string before comparing against "0" - meaning a still-in-flight
 * payment could have been reported as "failed", violating this system's core "a timeout is
 * never treated as a decline" rule.
 */
describe("DarajaMpesaAdapter.queryTransaction", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function mockOauthThen(queryResponse: Response) {
    fetchMock.mockImplementationOnce(async () => jsonResponse(200, { access_token: "tok", expires_in: "3600" }));
    fetchMock.mockImplementationOnce(async () => queryResponse);
  }

  it("treats ResultCode 4999 (a JSON number) as pending, not failed", async () => {
    mockOauthThen(jsonResponse(200, { ResultCode: 4999, ResultDesc: "The transaction is still under processing" }));
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.queryTransaction("ws_CO_test123");
    expect(result.status).toBe("pending");
  });

  it("treats ResultCode \"4999\" (a string) as pending too", async () => {
    mockOauthThen(jsonResponse(200, { ResultCode: "4999", ResultDesc: "The transaction is still under processing" }));
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.queryTransaction("ws_CO_test123");
    expect(result.status).toBe("pending");
  });

  it("treats a numeric ResultCode 0 as completed, not failed", async () => {
    mockOauthThen(jsonResponse(200, { ResultCode: 0, ResultDesc: "The service request is processed successfully." }));
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.queryTransaction("ws_CO_test123");
    expect(result.status).toBe("completed");
  });

  it("treats a genuine terminal failure (1037, DS timeout) as failed", async () => {
    mockOauthThen(jsonResponse(200, { ResultCode: 1037, ResultDesc: "DS timeout user cannot be reached." }));
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.queryTransaction("ws_CO_test123");
    expect(result.status).toBe("failed");
    expect(result.resultCode).toBe("1037");
  });

  it("returns pending for anything that isn't a real Daraja checkoutRequestId (e.g. a B2C conversationId)", async () => {
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.queryTransaction("AG_20260916_0100100abc123");
    expect(result.status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DarajaMpesaAdapter.stkPush / b2c", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("accepts a numeric ResponseCode 0 from the STK push response, not just a string", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(200, { access_token: "tok", expires_in: "3600" }));
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, { ResponseCode: 0, CheckoutRequestID: "ws_CO_abc" }),
    );
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.stkPush({
      tenantId: "t1",
      saleId: "s1",
      msisdn: "254708374149",
      amountMinorUnits: 100,
      accountReference: "ref",
      idempotencyKey: "idem-1",
    });
    expect(result).toEqual({ status: "accepted", checkoutRequestId: "ws_CO_abc" });
  });

  it("accepts a numeric ResponseCode 0 from the B2C response, not just a string", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(200, { access_token: "tok", expires_in: "3600" }));
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, { ResponseCode: 0, ConversationID: "AG_test" }),
    );
    const adapter = new DarajaMpesaAdapter(CONFIG);
    const result = await adapter.b2c({
      tenantId: "t1",
      payoutId: "p1",
      msisdn: "254708374149",
      amountMinorUnits: 1000,
      idempotencyKey: "idem-2",
    });
    expect(result).toEqual({ status: "accepted", conversationId: "AG_test" });
  });
});
