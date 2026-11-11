import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "mini",
  description: "A fast chat agent with web search and a memory of what you asked, and when.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
