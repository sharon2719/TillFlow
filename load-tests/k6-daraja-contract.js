// Daraja sandbox contract test - deliberately tiny (1 VU, 1 iteration), unlike every other
// script in load-tests/. Those all run against a LOCAL stack with the fake adapter
// specifically so nothing hammers a real external provider; this one's entire purpose is
// the opposite - proving the real deployed payments service's contract with the real
// Safaricom sandbox still holds (request accepted, response shape matches what
// DarajaMpesaAdapter expects), via one real STK push, once. No Daraja credentials are
// embedded here - this calls TillFlow's own public API, which handles Daraja auth
// internally; the sandbox test number (254708374149) is Safaricom's own published test
// value, not a secret.
//
// See evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md for the
// broader manual verification this contract test complements - that one caught two real
// bugs (a numeric-vs-string ResultCode mismatch); this one is the small, repeatable version
// meant to be run again whenever the integration might have drifted.
//
// Run: k6 run load-tests/k6-daraja-contract.js
import http from "k6/http";
import { check } from "k6";

const API_BASE = __ENV.API_BASE || "https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com";

export const options = {
  scenarios: {
    contract: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      exec: "daraja_stk_contract",
    },
  },
};

function uuid() {
  // k6's sandboxed JS runtime has no crypto.randomUUID - a fixed-format v4-shaped string is
  // enough here, this only needs to be unique per run, not cryptographically random.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function daraja_stk_contract() {
  const tenantId = uuid();
  const saleId = uuid();

  const res = http.post(
    `${API_BASE}/api/v1/payments/stk`,
    JSON.stringify({
      tenantId,
      saleId,
      msisdn: "254708374149", // Safaricom's own published sandbox test number - not a secret
      amountMinorUnits: 100,
      accountReference: "k6-daraja-contract-test",
      idempotencyKey: `k6-contract-${Date.now()}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "accepted (201)": (r) => r.status === 201,
    "real Daraja checkoutRequestId (ws_CO_ prefix, not fake-checkout-)": (r) => {
      const body = r.json();
      return typeof body.checkoutRequestId === "string" && body.checkoutRequestId.startsWith("ws_CO_");
    },
    "status is pending (never a decline on acceptance)": (r) => r.json().status === "pending",
  });
}
