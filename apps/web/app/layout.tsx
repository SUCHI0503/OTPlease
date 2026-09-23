import type { Metadata } from "next";
import Link from "next/link";
import { logout } from "./actions";
import { getToken } from "@/lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: "OTPlease dashboard",
  description: "Manage applications, API keys and webhooks, and see usage.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const signedIn = Boolean(await getToken());
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">OTPlease</Link>
          {signedIn && (
            <form action={logout}>
              <button className="link">Sign out</button>
            </form>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
