/**
 * The one boundary the Payments service is allowed to cross into the outside world.
 * Everything that talks to Daraja goes through this interface, so:
 *   - CI and k6 run against `FakeMpesaAdapter` (deterministic, no network, no real money)
 *   - the Daraja sandbox is only ever wired in behind `DarajaMpesaAdapter` (to be written
 *     alongside the Payments service in G2)
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
 * Deterministic fake for CI and k6. No network calls, no timing variance beyond what's
 * explicitly configured. Real scenario injection (forced timeout, forced failure) is added
 * alongside the Payments service tests in G2 — this is the interface shape, not the full
 * behavior yet.
 */
export class FakeMpesaAdapter implements MpesaAdapter {
  private readonly seenIdempotencyKeys = new Set<string>();

  async stkPush(req: StkPushRequest): Promise<StkPushResult> {
    if (this.seenIdempotencyKeys.has(req.idempotencyKey)) {
      return { status: "rejected", reason: "duplicate idempotency key" };
    }
    this.seenIdempotencyKeys.add(req.idempotencyKey);
    return { status: "accepted", checkoutRequestId: `fake-checkout-${req.idempotencyKey}` };
  }

  async b2c(req: B2cRequest): Promise<B2cResult> {
    if (this.seenIdempotencyKeys.has(req.idempotencyKey)) {
      return { status: "rejected", reason: "duplicate idempotency key" };
    }
    this.seenIdempotencyKeys.add(req.idempotencyKey);
    return { status: "accepted", conversationId: `fake-conversation-${req.idempotencyKey}` };
  }

  async queryTransaction(): Promise<TransactionQueryResult> {
    // TODO(G2): make this configurable per-test (pending / completed / failed) once the
    // Payments service exists to drive it.
    return { status: "completed", resultCode: "0", resultDescription: "fake success" };
  }
}
