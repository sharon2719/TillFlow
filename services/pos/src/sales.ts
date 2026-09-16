import { Router } from "express";

export interface SaleItemInput {
  sku: string;
  quantity: number;
  unitPriceMinorUnits: number;
}

export interface SaleInput {
  tenantId: string;
  attendantId: string;
  items: SaleItemInput[];
}

export interface SaleRecord {
  saleId: string;
  tenantId: string;
  attendantId: string;
  totalMinorUnits: number;
  status: "recorded";
  items: SaleItemInput[];
}

const seenIdempotencyKeys = new Set<string>();

const validateSale = (body: unknown): { value: SaleInput; idempotencyKey?: string } => {
  if (!body || typeof body !== "object") {
    throw new Error("request body is required");
  }

  const payload = body as Record<string, unknown>;
  const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined;

  if (typeof payload.tenantId !== "string" || !payload.tenantId.trim()) {
    throw new Error("tenantId is required");
  }

  if (typeof payload.attendantId !== "string" || !payload.attendantId.trim()) {
    throw new Error("attendantId is required");
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  const items = payload.items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`items[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.sku !== "string" || !record.sku.trim()) {
      throw new Error(`items[${index}].sku is required`);
    }
    if (typeof record.quantity !== "number" || !Number.isFinite(record.quantity) || record.quantity <= 0) {
      throw new Error(`items[${index}].quantity must be a positive number`);
    }
    if (typeof record.unitPriceMinorUnits !== "number" || !Number.isFinite(record.unitPriceMinorUnits) || record.unitPriceMinorUnits < 0) {
      throw new Error(`items[${index}].unitPriceMinorUnits must be a non-negative number`);
    }

    return {
      sku: record.sku,
      quantity: record.quantity,
      unitPriceMinorUnits: record.unitPriceMinorUnits,
    } satisfies SaleItemInput;
  });

  return {
    value: {
      tenantId: payload.tenantId,
      attendantId: payload.attendantId,
      items,
    },
    idempotencyKey,
  };
};

export const salesRouter = Router();

salesRouter.post("/api/v1/sales", (req, res) => {
  try {
    const { value, idempotencyKey } = validateSale(req.body);
    const idKey = idempotencyKey ?? req.get("Idempotency-Key") ?? req.headers["idempotency-key"];
    const key = typeof idKey === "string" && idKey.trim() ? idKey : `sale-${crypto.randomUUID()}`;

    if (seenIdempotencyKeys.has(key)) {
      return res.status(409).json({ error: "Duplicate idempotency key" });
    }

    const totalMinorUnits = value.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceMinorUnits,
      0,
    );

    const sale: SaleRecord = {
      saleId: `sale-${crypto.randomUUID()}`,
      tenantId: value.tenantId,
      attendantId: value.attendantId,
      totalMinorUnits,
      status: "recorded",
      items: value.items,
    };

    seenIdempotencyKeys.add(key);

    return res.status(201).json(sale);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid sale payload";
    return res.status(400).json({ error: message });
  }
});
