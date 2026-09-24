import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo app",
  description: "A sample app that signs users in with OTPlease.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
