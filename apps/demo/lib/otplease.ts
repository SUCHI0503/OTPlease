import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";

// This file is the whole integration. The API key lives only here, on the server: it never reaches the browser.
const BASE = process.env.OTPLEASE_URL ?? "http://localhost:4000";
const APP_ID = process.env.OTPLEASE_APP_ID ?? "";
const API_KEY = process.env.OTPLEASE_API_KEY ?? "";

export const SESSION_COOKIE = "demo_session";
const DEVICE_COOKIE = "demo_device";

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

async function call<T>(path: string, init: { method?: string; body?: unknown; bearer?: string; useKey?: boolean }): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.useKey ? { "x-api-key": API_KEY } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, code: json?.error?.code ?? "ERROR", message: json?.error?.message ?? "request failed" };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, code: "UNREACHABLE", message: "could not reach the authentication service" };
  }
}

/**
 * What OTPlease can learn about this visitor. It only sees our server, so we forward the visitor's device and
 * IP. The device id is a random value we keep in a cookie, so a returning browser is recognised as known.
 */
export async function visitorContext() {
  const jar = await cookies();
  let deviceId = jar.get(DEVICE_COOKIE)?.value;
  if (!deviceId) {
    deviceId = randomBytes(16).toString("hex");
    jar.set(DEVICE_COOKIE, deviceId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    deviceId,
    ...(forwarded ? { ip: forwarded } : {}),
    ...(h.get("user-agent") ? { userAgent: h.get("user-agent")!.slice(0, 200) } : {}),
  };
}

export const requestCode = async (phone: string) =>
  call<{ userId: string }>(`/applications/${APP_ID}/otp/request`, {
    method: "POST",
    useKey: true,
    body: { phone, context: await visitorContext() },
  });

export const verifyCode = async (phone: string, code: string) =>
  call<Session & { userId: string }>(`/applications/${APP_ID}/otp/verify`, {
    method: "POST",
    useKey: true,
    body: { phone, code, context: await visitorContext() },
  });

export const whoAmI = (accessToken: string) =>
  call<{ userId: string; sessionId: string }>("/auth/me", { bearer: accessToken });

export const endSession = (accessToken: string) => call<void>("/auth/logout", { method: "POST", bearer: accessToken });

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}
