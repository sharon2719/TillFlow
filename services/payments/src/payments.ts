import { Router } from "express";

interface StkPushRequest {
  tenantId: string;
  saleId: string;
  msisdn: string;
  amountMinorUnits: number;
  accountReference: string;
  idempotencyKey: string;
}

interface B2cRequest {
  tenantId: string;
  payoutId: string;
  msisdn: string;
  amountMinorUnits: number;
  idempotencyKey: string;
}

type PaymentStatus = "pending" | "completed" | "failed";

interface PaymentRecord {
  paymentId: string;
  tenantId: string;
  saleId: string;
  msisdn: string;
  amountMinorUnits: number;
  accountReference: string;
  status: PaymentStatus;
  checkoutRequestId: string;
  idempotencyKey: string;
}

interface PayoutRecord {
  payoutId: string;
  tenantId: string;
  msisdn: string;
  amountMinorUnits: number;
  status: PaymentStatus;
  conversationId: string;
  idempotencyKey: string;
}

const stkRequests = new Map<string, PaymentRecord>();
const b2cRequests = new Map<string, PayoutRecord>();
const seenStkKeys = new Set<string>();
const seenB2cKeys = new Set<string>();

const isValidMsisdn = (value: string) => /^254[0-9]{9}$/.test(value);

const validateStk = (body: unknown): StkPushRequest => {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const payload = body as Record<string, unknown>;

  if (typeof payload.tenantId !== "string" || !payload.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof payload.saleId !== "string" || !payload.saleId.trim()) throw new Error("saleId is required");
  if (typeof payload.msisdn !== "string" || !isValidMsisdn(payload.msisdn)) throw new Error("msisdn must be a valid 254 format number");
  if (typeof payload.accountReference !== "string" || !payload.accountReference.trim()) throw new Error("accountReference is required");
  if (typeof payload.idempotencyKey !== "string" || !payload.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (typeof payload.amountMinorUnits !== "number" || !Number.isFinite(payload.amountMinorUnits) || payload.amountMinorUnits <= 0) {
    throw new Error("amountMinorUnits must be a positive number");
  }

  return {
    tenantId: payload.tenantId,
    saleId: payload.saleId,
    msisdn: payload.msisdn,
    amountMinorUnits: payload.amountMinorUnits,
    accountReference: payload.accountReference,
    idempotencyKey: payload.idempotencyKey,
  } satisfies StkPushRequest;
};

const validateB2c = (body: unknown): B2cRequest => {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const payload = body as Record<string, unknown>;

  if (typeof payload.tenantId !== "string" || !payload.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof payload.payoutId !== "string" || !payload.payoutId.trim()) throw new Error("payoutId is required");
  if (typeof payload.msisdn !== "string" || !isValidMsisdn(payload.msisdn)) throw new Error("msisdn must be a valid 254 format number");
  if (typeof payload.idempotencyKey !== "string" || !payload.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (typeof payload.amountMinorUnits !== "number" || !Number.isFinite(payload.amountMinorUnits) || payload.amountMinorUnits <= 0) {
    throw new Error("amountMinorUnits must be a positive number");
  }

  return {
    tenantId: payload.tenantId,
    payoutId: payload.payoutId,
    msisdn: payload.msisdn,
    amountMinorUnits: payload.amountMinorUnits,
    idempotencyKey: payload.idempotencyKey,
  } satisfies B2cRequest;
};

export const paymentsRouter = Router();

paymentsRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

paymentsRouter.post("/api/v1/payments/stk", (req, res) => {
  try {
    const body = validateStk(req.body);

    if (seenStkKeys.has(body.idempotencyKey)) {
      return res.status(409).json({ error: "Duplicate idempotency key" });
    }

    const payment: PaymentRecord = {
      paymentId: `pay-${crypto.randomUUID()}`,
      tenantId: body.tenantId,
      saleId: body.saleId,
      msisdn: body.msisdn,
      amountMinorUnits: body.amountMinorUnits,
      accountReference: body.accountReference,
      status: "pending",
      checkoutRequestId: `checkout-${crypto.randomUUID()}`,
      idempotencyKey: body.idempotencyKey,
    };

    seenStkKeys.add(body.idempotencyKey);
    stkRequests.set(payment.checkoutRequestId, payment);

    return res.status(201).json({
      paymentId: payment.paymentId,
      tenantId: payment.tenantId,
      saleId: payment.saleId,
      msisdn: payment.msisdn,
      amountMinorUnits: payment.amountMinorUnits,
      accountReference: payment.accountReference,
      status: payment.status,
      checkoutRequestId: payment.checkoutRequestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid STK request";
    return res.status(400).json({ error: message });
  }
});

paymentsRouter.post("/api/v1/payments/callback", (req, res) => {
  const { checkoutRequestId, status, resultCode, resultDescription } = req.body as {
    checkoutRequestId?: string;
    status?: string;
    resultCode?: string;
    resultDescription?: string;
  };

  if (!checkoutRequestId || typeof checkoutRequestId !== "string") {
    return res.status(400).json({ error: "checkoutRequestId is required" });
  }

  const payment = stkRequests.get(checkoutRequestId);
  if (!payment) {
    return res.status(404).json({ error: "payment not found" });
  }

  const nextStatus = status === "completed" || resultCode === "0" ? "completed" : "failed";
  payment.status = nextStatus;

  return res.status(200).json({
    paymentId: payment.paymentId,
    checkoutRequestId: payment.checkoutRequestId,
    status: payment.status,
    resultCode,
    resultDescription,
  });
});

paymentsRouter.post("/api/v1/payments/b2c", (req, res) => {
  try {
    const body = validateB2c(req.body);

    if (seenB2cKeys.has(body.idempotencyKey)) {
      return res.status(409).json({ error: "Duplicate idempotency key" });
    }

    const payout: PayoutRecord = {
      payoutId: `payout-${crypto.randomUUID()}`,
      tenantId: body.tenantId,
      msisdn: body.msisdn,
      amountMinorUnits: body.amountMinorUnits,
      status: "pending",
      conversationId: `conv-${crypto.randomUUID()}`,
      idempotencyKey: body.idempotencyKey,
    };

    seenB2cKeys.add(body.idempotencyKey);
    b2cRequests.set(payout.conversationId, payout);

    return res.status(201).json({
      payoutId: payout.payoutId,
      tenantId: payout.tenantId,
      msisdn: payout.msisdn,
      amountMinorUnits: payout.amountMinorUnits,
      status: payout.status,
      conversationId: payout.conversationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid B2C request";
    return res.status(400).json({ error: message });
  }
});
