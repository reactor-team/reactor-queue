import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reactor queue — basic example",
  description: "A Reactor model gated behind @reactor-team/queue, in one page.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
