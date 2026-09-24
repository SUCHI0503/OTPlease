"use client";

import { useActionState, useState } from "react";
import { checkCode, sendCode, type LoginState } from "@/app/actions";

const start: LoginState = { step: "phone" };

export function LoginForm() {
  const [sent, sendAction, sending] = useActionState(sendCode, start);
  const [checked, checkAction, checking] = useActionState(checkCode, start);
  const [restarted, setRestarted] = useState(0);

  // The code step shows while the last "send" succeeded and the visitor has not chosen to start over
  const onCodeStep = sent.step === "code" && restarted === 0;
  const phone = sent.phone ?? "";

  if (onCodeStep) {
    return (
      <form action={checkAction} className="stack" aria-labelledby="code-title">
        <h1 id="code-title">Enter your code</h1>
        <p className="muted">We sent a 6-digit code to {phone}.</p>
        <input type="hidden" name="phone" value={phone} />
        <label>
          Verification code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
        </label>
        <button disabled={checking}>{checking ? "Checking…" : "Verify"}</button>
        {checked.error && <p className="error" role="alert">{checked.error}</p>}
        <button type="button" className="link" onClick={() => setRestarted((n) => n + 1)}>
          Use a different number
        </button>
      </form>
    );
  }

  return (
    <form action={(fd) => { setRestarted(0); sendAction(fd); }} className="stack" aria-labelledby="phone-title">
      <h1 id="phone-title">Sign in</h1>
      <p className="muted">We&apos;ll text you a one-time code.</p>
      <label>
        Phone number
        <input name="phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" defaultValue={restarted ? "" : sent.phone ?? ""} required />
      </label>
      <button disabled={sending}>{sending ? "Sending…" : "Send code"}</button>
      {sent.error && <p className="error" role="alert">{sent.error}</p>}
    </form>
  );
}
