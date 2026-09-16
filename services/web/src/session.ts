import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * web has no database of its own - it never stores the tenant's data, only forwards the
 * caller's own API key on to pos/payments/commission (see backend.ts). The session is
 * nothing more than that same API key, HMAC-signed so a client can't forge or tamper with
 * it, carried in an HttpOnly cookie instead of a server-side session store.
 */
const COOKIE_NAME = "tillflow_session";

function sign(value: string, secret: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function verify(cookieValue: string, secret: string): string | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [encoded, mac] = parts;
  const expectedMac = createHmac("sha256", secret).update(encoded).digest("base64url");
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function readSessionApiKey(cookieHeader: string | undefined, secret: string): string | null {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  return verify(raw, secret);
}

export function sessionCookieHeader(apiKey: string, secret: string): string {
  const signed = sign(apiKey, secret);
  return `${COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
