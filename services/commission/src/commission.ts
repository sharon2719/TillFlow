import { Router } from "express";

interface PaidSale {
  saleId: string;
  attendantId: string;
  attendantMsisdn: string;
  totalMinorUnits: number;
  paymentStatus: "paid" | "pending" | "failed";
}

interface CloseRequest {
  tenantId: string;
  businessDate: string;
  commissionRateBps: number;
  sales: PaidSale[];
}

interface PayoutLedgerEntry {
  payoutId: string;
  tenantId: string;
  businessDate: string;
  attendantId: string;
  attendantMsisdn: string;
  amountMinorUnits: number;
  status: "requested";
}

const closeKeys = new Set<string>();
const payoutLedger = new Map<string, PayoutLedgerEntry>();

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isMsisdn = (value: string) => /^254\d{9}$/.test(value);

const validate = (body: unknown): CloseRequest => {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const payload = body as Record<string, unknown>;
  if (typeof payload.tenantId !== "string" || !payload.tenantId.trim()) throw new Error("tenantId is required");
  if (typeof payload.businessDate !== "string" || !isDate(payload.businessDate)) throw new Error("businessDate must be YYYY-MM-DD");
  if (typeof payload.commissionRateBps !== "number" || !Number.isInteger(payload.commissionRateBps) || payload.commissionRateBps < 0 || payload.commissionRateBps > 10000) {
    throw new Error("commissionRateBps must be an integer between 0 and 10000");
  }
  if (!Array.isArray(payload.sales)) throw new Error("sales must be an array");

  const sales = payload.sales.map((sale, index) => {
    if (!sale || typeof sale !== "object") throw new Error(`sales[${index}] must be an object`);
    const item = sale as Record<string, unknown>;
    if (typeof item.saleId !== "string" || !item.saleId.trim()) throw new Error(`sales[${index}].saleId is required`);
    if (typeof item.attendantId !== "string" || !item.attendantId.trim()) throw new Error(`sales[${index}].attendantId is required`);
    if (typeof item.attendantMsisdn !== "string" || !isMsisdn(item.attendantMsisdn)) throw new Error(`sales[${index}].attendantMsisdn is invalid`);
    if (typeof item.totalMinorUnits !== "number" || !Number.isInteger(item.totalMinorUnits) || item.totalMinorUnits <= 0) throw new Error(`sales[${index}].totalMinorUnits is invalid`);
    if (item.paymentStatus !== "paid" && item.paymentStatus !== "pending" && item.paymentStatus !== "failed") throw new Error(`sales[${index}].paymentStatus is invalid`);

    return {
      saleId: item.saleId,
      attendantId: item.attendantId,
      attendantMsisdn: item.attendantMsisdn,
      totalMinorUnits: item.totalMinorUnits,
      paymentStatus: item.paymentStatus,
    } satisfies PaidSale;
  });

  return { tenantId: payload.tenantId, businessDate: payload.businessDate, commissionRateBps: payload.commissionRateBps, sales };
};

export const commissionRouter = Router();

commissionRouter.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

commissionRouter.post("/api/v1/commission/close", (req, res) => {
  try {
    const close = validate(req.body);
    const idempotencyKey = req.get("Idempotency-Key");
    if (!idempotencyKey?.trim()) return res.status(400).json({ error: "Idempotency-Key is required" });
    const closeKey = `${close.tenantId}:${close.businessDate}:${idempotencyKey}`;

    if (closeKeys.has(closeKey)) return res.status(409).json({ error: "Commission close already processed" });

    const eligible = close.sales.filter((sale) => sale.paymentStatus === "paid");
    const payouts = eligible.map((sale) => {
      const payout: PayoutLedgerEntry = {
        payoutId: `payout-${crypto.randomUUID()}`,
        tenantId: close.tenantId,
        businessDate: close.businessDate,
        attendantId: sale.attendantId,
        attendantMsisdn: sale.attendantMsisdn,
        amountMinorUnits: Math.floor((sale.totalMinorUnits * close.commissionRateBps) / 10000),
        status: "requested",
      };
      payoutLedger.set(payout.payoutId, payout);
      return payout;
    });

    closeKeys.add(closeKey);
    return res.status(201).json({ tenantId: close.tenantId, businessDate: close.businessDate, eligibleSales: eligible.length, payouts });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid commission close" });
  }
});
