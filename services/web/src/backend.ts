export interface BackendResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export type FetchImpl = typeof fetch;

/**
 * Thin fetch wrapper shared by every downstream call web makes to pos/payments/commission.
 * fetchImpl is injected (defaults to the real global fetch in app.ts) so tests can supply a
 * fake without a real network - same pattern as commission's B2cCaller.
 */
export async function backendRequest<T = Record<string, unknown>>(
  fetchImpl: FetchImpl,
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Promise<BackendResponse<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (init.apiKey) headers.Authorization = `Bearer ${init.apiKey}`;

  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}
