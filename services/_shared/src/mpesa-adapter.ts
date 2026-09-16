/**
 * The one boundary the Payments service is allowed to cross into the outside world.
 * Everything that talks to Daraja goes through this interface, so:
 *   - CI and k6 run against `FakeMpesaAdapter` (deterministic, no network, no real money)
 *   - the Daraja sandbox is only ever wired in behind `DarajaMpesaAdapter` (not written yet
 *     - services/payments still runs entirely against the fake; real sandbox integration
 *     is open work, see docs/production-readiness.md)
 *   - Commission never gets a reference to either implementation — it only ever calls the
 *     Payments service's own internal API, never this adapter directly.
 */

export interface StkPushRequest {
  tenantId: string;
  saleId: string;
  msisdn: string;
  amountMinorUnits: number;
  accountReference: string;
  /** Client-supplied idempotency key; the adapter must not originate two charges for one key. */
  idempotencyKey: string;
  /**
   * Test/demo hook only - a real DarajaMpesaAdapter has no such parameter, since Daraja
   * doesn't take instructions on how to behave. "timeout" simulates Daraja accepting the
   * push (the phone prompt goes out) but the result callback never arriving - the
   * transaction sits "pending" until something resolves it, same as a real lost webhook.
   * "reject" simulates Daraja synchronously declining the push itself (e.g. invalid
   * number) - a real decline, not a timeout, so it should NOT be treated the same way.
   */
  simulate?: "timeout" | "reject";
}

export type StkPushResult =
  | { status: "accepted"; checkoutRequestId: string }
  | { status: "rejected"; reason: string };

export interface B2cRequest {
  tenantId: string;
  payoutId: string;
  msisdn: string;
  amountMinorUnits: number;
  /** Client-supplied idempotency key; must be safe to retry with the same key. */
  idempotencyKey: string;
  /** Same test/demo hook as StkPushRequest.simulate. */
  simulate?: "timeout" | "reject";
}

export type B2cResult =
  | { status: "accepted"; conversationId: string }
  | { status: "rejected"; reason: string };

/**
 * A transaction's true state as far as Daraja is concerned — deliberately distinct from
 * TillFlow's own domain states. "pending" here means Daraja itself hasn't resolved the
 * transaction yet; it is NOT the same as a TillFlow-side decline and must never be treated
 * as one (see docs/threat-model.md, threat #2).
 */
export type TransactionStatus = "pending" | "completed" | "failed";

export interface TransactionQueryResult {
  status: TransactionStatus;
  /** Present once Daraja has resolved the transaction one way or the other. */
  resultCode?: string;
  resultDescription?: string;
}

export interface MpesaAdapter {
  stkPush(req: StkPushRequest): Promise<StkPushResult>;
  b2c(req: B2cRequest): Promise<B2cResult>;
  queryTransaction(checkoutOrConversationId: string): Promise<TransactionQueryResult>;
}

/**
 * Deterministic fake for CI and k6 - no network calls, no real timing variance. Tracks
 * transaction state internally so `queryTransaction` (Payments' reconciliation path) can
 * actually observe a transaction moving from pending to resolved, rather than always
 * returning a canned "completed".
 */
export class FakeMpesaAdapter implements MpesaAdapter {
  private readonly seenIdempotencyKeys = new Set<string>();
  private readonly transactions = new Map<string, TransactionQueryResult>();

  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    if (this.seenIdempotencyKeys.has(req.idempotencyKey)) {
      return { status: "rejected", reason: "duplicate idempotency key" };
    }

    if (req.simulate === "reject") {
      // A genuine synchronous decline - Daraja itself refused the push. Not a timeout, and
      // the caller should treat it as a real decline, unlike "timeout" below. Still marks
      // the idempotency key as seen, so a client retry with the same key is still blocked.
      this.seenIdempotencyKeys.add(req.idempotencyKey);
      return { status: "rejected", reason: "simulated Daraja rejection" };
    }

    this.seenIdempotencyKeys.add(req.idempotencyKey);
    const checkoutRequestId = `fake-checkout-${req.idempotencyKey}`;
    this.transactions.set(
      checkoutRequestId,
      req.simulate === "timeout"
        ? { status: "pending" }
        : { status: "completed", resultCode: "0", resultDescription: "fake success" },
    );
    return { status: "accepted", checkoutRequestId };
  }

  async b2c(req: B2cRequest): Promise<B2cResult> {
    if (this.seenIdempotencyKeys.has(req.idempotencyKey)) {
      return { status: "rejected", reason: "duplicate idempotency key" };
    }

    if (req.simulate === "reject") {
      this.seenIdempotencyKeys.add(req.idempotencyKey);
      return { status: "rejected", reason: "simulated Daraja rejection" };
    }

    this.seenIdempotencyKeys.add(req.idempotencyKey);
    const conversationId = `fake-conversation-${req.idempotencyKey}`;
    this.transactions.set(
      conversationId,
      req.simulate === "timeout"
        ? { status: "pending" }
        : { status: "completed", resultCode: "0", resultDescription: "fake success" },
    );
    return { status: "accepted", conversationId };
  }

  async queryTransaction(checkoutOrConversationId: string): Promise<TransactionQueryResult> {
    return this.transactions.get(checkoutOrConversationId) ?? { status: "pending" };
  }

  /**
   * Test/demo-only helper: simulates the delayed callback finally arriving for a
   * "timeout"-simulated transaction, or a reconciliation job discovering the true result.
   * A real DarajaMpesaAdapter has no equivalent - Daraja resolves transactions on its own
   * schedule, nothing in this codebase "tells" it the answer.
   */
  simulateResolution(checkoutOrConversationId: string, status: "completed" | "failed"): void {
    this.transactions.set(checkoutOrConversationId, {
      status,
      resultCode: status === "completed" ? "0" : "1",
      resultDescription: status === "completed" ? "fake success" : "fake failure",
    });
  }
}
