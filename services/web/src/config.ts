export interface WebConfig {
  posApiUrl: string;
  paymentsApiUrl: string;
  commissionApiUrl: string;
  sessionSecret: string;
}

export function loadConfig(): WebConfig {
  return {
    posApiUrl: process.env.POS_API_URL ?? "http://localhost:3000",
    paymentsApiUrl: process.env.PAYMENTS_API_URL ?? "http://localhost:3001",
    commissionApiUrl: process.env.COMMISSION_API_URL ?? "http://localhost:3002",
    // Only signs the session cookie (see session.ts) - not a credential store of its own.
    // Falling back to a fixed dev value keeps `npm run dev` working without extra setup;
    // production always sets SESSION_SECRET via Terraform (infra/ecs-web.tf).
    sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  };
}
