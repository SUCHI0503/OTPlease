import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSession, whoAmI } from "@/lib/otplease";

export default async function Account() {
  const session = await getSession();
  if (!session) redirect("/");

  // Every visit asks OTPlease whether the session is still alive, so a logout or revocation takes effect at once
  const me = await whoAmI(session.accessToken);
  if (!me.ok) redirect("/");

  return (
    <section className="stack">
      <h1>Welcome back</h1>
      <p>You are signed in.</p>
      <dl>
        <dt>User</dt>
        <dd data-testid="user-id">{me.data.userId}</dd>
        <dt>Session</dt>
        <dd data-testid="session-id">{me.data.sessionId}</dd>
      </dl>
      <form action={logout}>
        <button>Sign out</button>
      </form>
    </section>
  );
}
