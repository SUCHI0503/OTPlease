"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, endSession, getSession, requestCode, verifyCode } from "@/lib/otplease";

export interface LoginState {
  step: "phone" | "code";
  phone?: string;
  error?: string;
}

export async function sendCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const phone = String(form.get("phone") ?? "").trim();
  if (!phone) return { step: "phone", error: "Enter your phone number." };

  const res = await requestCode(phone);
  if (res.ok) return { step: "code", phone };

  const messages: Record<string, string> = {
    RATE_LIMITED: "Too many attempts. Please wait a few minutes and try again.",
    RISK_BLOCKED: "We can't send a code to this number.",
    VALIDATION_ERROR: "That doesn't look like a valid phone number.",
  };
  return { step: "phone", phone, error: messages[res.code] ?? "Something went wrong. Please try again." };
}

export async function checkCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const phone = String(form.get("phone") ?? "");
  const code = String(form.get("code") ?? "").trim();

  const res = await verifyCode(phone, code);
  if (!res.ok) {
    const messages: Record<string, string> = {
      OTP_INCORRECT: "That code is wrong. Check it and try again.",
      OTP_EXPIRED: "That code has expired. Request a new one.",
      OTP_NOT_FOUND: "There is no active code. Request a new one.",
      RATE_LIMITED: "Too many attempts. Please wait a few minutes.",
      OTP_LOCKED: "Too many wrong attempts. Request a new code.",
      VALIDATION_ERROR: "Enter the 6-digit code.",
    };
    return { step: "code", phone, error: messages[res.code] ?? "Something went wrong. Please try again." };
  }

  // Tokens go in an httpOnly cookie: page scripts can never read them
  (await cookies()).set(SESSION_COOKIE, JSON.stringify({ accessToken: res.data.accessToken, refreshToken: res.data.refreshToken }), {
    httpOnly: true,
    sameSite: "lax",
    // COOKIE_SECURE=false lets the Docker stack run over plain http://localhost (Safari refuses Secure cookies there)
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/account");
}

export async function logout() {
  const session = await getSession();
  // End the session on the server first, so the token is useless even if someone copied it
  if (session) await endSession(session.accessToken);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
