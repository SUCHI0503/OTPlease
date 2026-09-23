"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { TOKEN_COOKIE, callApi } from "@/lib/api";

export interface FormState {
  error?: string;
  /** Shown once: API keys and webhook secrets are never retrievable again */
  secret?: { label: string; value: string };
  ok?: boolean;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const token = text(form, "token");
  if (!token) return { error: "Enter the admin token." };

  // The API is the judge: a token is only stored if the API accepts it
  const check = await callApi("/analytics/overview?days=1", { token });
  if (!check.ok) {
    return { error: check.status === 401 ? "That token was not accepted." : check.message };
  }

  (await cookies()).set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect("/login");
}

export async function createApplication(_prev: FormState, form: FormData): Promise<FormState> {
  const name = text(form, "name");
  if (!name) return { error: "Give the application a name." };
  const res = await callApi("/applications", { method: "POST", body: { name } });
  if (!res.ok) return { error: res.message };
  revalidatePath("/");
  return { ok: true };
}

export async function createApiKey(_prev: FormState, form: FormData): Promise<FormState> {
  const applicationId = text(form, "applicationId");
  const scopes = form.getAll("scopes").map(String);
  const name = text(form, "name");
  if (!name) return { error: "Give the key a name." };
  if (scopes.length === 0) return { error: "Pick at least one scope." };

  const res = await callApi<{ key: string }>(`/applications/${applicationId}/api-keys`, {
    method: "POST",
    body: { name, scopes },
  });
  if (!res.ok) return { error: res.message };
  revalidatePath(`/apps/${applicationId}`);
  return { secret: { label: "API key", value: res.data.key } };
}

export async function revokeApiKey(form: FormData) {
  const applicationId = text(form, "applicationId");
  await callApi(`/applications/${applicationId}/api-keys/${text(form, "keyId")}`, { method: "DELETE" });
  revalidatePath(`/apps/${applicationId}`);
}

export async function createWebhook(_prev: FormState, form: FormData): Promise<FormState> {
  const applicationId = text(form, "applicationId");
  const events = form.getAll("events").map(String);
  const url = text(form, "url");
  if (!url) return { error: "Enter the endpoint URL." };
  if (events.length === 0) return { error: "Pick at least one event." };

  const res = await callApi<{ secret: string }>(`/applications/${applicationId}/webhooks`, {
    method: "POST",
    body: { url, events },
  });
  if (!res.ok) return { error: res.message };
  revalidatePath(`/apps/${applicationId}`);
  return { secret: { label: "Signing secret", value: res.data.secret } };
}

export async function revokeWebhook(form: FormData) {
  const applicationId = text(form, "applicationId");
  await callApi(`/applications/${applicationId}/webhooks/${text(form, "webhookId")}`, { method: "DELETE" });
  revalidatePath(`/apps/${applicationId}`);
}
