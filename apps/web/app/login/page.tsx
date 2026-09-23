import { redirect } from "next/navigation";
import { LoginForm } from "@/components/forms";
import { callApi, getToken } from "@/lib/api";

export default async function LoginPage() {
  // Already signed in with a working token: go straight to the dashboard
  if ((await getToken()) && (await callApi("/analytics/overview?days=1")).ok) redirect("/");
  return (
    <section className="narrow">
      <h1>Sign in</h1>
      <p className="muted">Use the platform admin token from your server configuration.</p>
      <LoginForm />
    </section>
  );
}
