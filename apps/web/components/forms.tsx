"use client";

import { useActionState, useRef } from "react";
import {
  createApiKey,
  createApplication,
  createWebhook,
  login,
  type FormState,
} from "@/app/actions";
import { SCOPES, WEBHOOK_EVENTS } from "@/lib/types";

const initial: FormState = {};

function Feedback({ state }: { state: FormState }) {
  return (
    <>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {state.secret && (
        <div className="secret" role="status">
          <strong>{state.secret.label}. Copy it now, it will not be shown again:</strong>
          <code>{state.secret.value}</code>
        </div>
      )}
    </>
  );
}

export function LoginForm() {
  const [state, action, pending] = useActionState(login, initial);
  return (
    <form action={action} className="stack">
      <label>
        Admin token
        <input name="token" type="password" autoComplete="off" required />
      </label>
      <button disabled={pending}>{pending ? "Checking…" : "Sign in"}</button>
      <Feedback state={state} />
    </form>
  );
}

export function CreateApplicationForm() {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const result = await createApplication(prev, form);
    if (result.ok) ref.current?.reset();
    return result;
  }, initial);
  return (
    <form ref={ref} action={action} className="row">
      <input name="name" placeholder="New application name" maxLength={100} required aria-label="Application name" />
      <button disabled={pending}>{pending ? "Creating…" : "Create application"}</button>
      <Feedback state={state} />
    </form>
  );
}

export function CreateKeyForm({ applicationId }: { applicationId: string }) {
  const [state, action, pending] = useActionState(createApiKey, initial);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input name="name" placeholder="Key name, e.g. production backend" maxLength={100} required aria-label="Key name" />
      <fieldset>
        <legend>Scopes</legend>
        {SCOPES.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" name="scopes" value={s} /> {s}
          </label>
        ))}
      </fieldset>
      <button disabled={pending}>{pending ? "Creating…" : "Create API key"}</button>
      <Feedback state={state} />
    </form>
  );
}

export function CreateWebhookForm({ applicationId }: { applicationId: string }) {
  const [state, action, pending] = useActionState(createWebhook, initial);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input name="url" type="url" placeholder="https://example.com/otplease-webhook" required aria-label="Endpoint URL" />
      <fieldset>
        <legend>Events</legend>
        {WEBHOOK_EVENTS.map((e) => (
          <label key={e} className="check">
            <input type="checkbox" name="events" value={e} /> {e}
          </label>
        ))}
      </fieldset>
      <button disabled={pending}>{pending ? "Adding…" : "Add webhook"}</button>
      <Feedback state={state} />
    </form>
  );
}
