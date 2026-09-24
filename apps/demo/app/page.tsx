import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getSession, whoAmI } from "@/lib/otplease";

export default async function Home() {
  // Already signed in with a session the server still accepts: go straight to the account page
  const session = await getSession();
  if (session && (await whoAmI(session.accessToken)).ok) redirect("/account");
  return <LoginForm />;
}
