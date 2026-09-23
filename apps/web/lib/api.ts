import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Server-only: this module is imported only by server components and server actions,
// so the admin token never reaches browser JavaScript.
const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const TOKEN_COOKIE = "otp_admin";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export async function getToken(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}

export async function callApi<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {}
): Promise<ApiResult<T>> {
  const token = init.token ?? (await getToken());
  if (!token) return { ok: false, status: 401, message: "not signed in" };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { "x-admin-token": token, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = json?.error?.details?.[0]?.message;
      return { ok: false, status: res.status, message: detail ?? json?.error?.message ?? `request failed (${res.status})` };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, message: "could not reach the OTPlease API" };
  }
}

/** For pages: returns data, or sends the user to the login page if the token is missing or wrong. */
export async function loadOrLogin<T>(path: string): Promise<ApiResult<T>> {
  const result = await callApi<T>(path);
  if (!result.ok && result.status === 401) redirect("/login");
  return result;
}
