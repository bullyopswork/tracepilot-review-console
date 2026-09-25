import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TracePilot — Review Console",
  description:
    "Inspect an agent run, trace its constraints, and review the evidence before changing the next task. Synthetic portfolio demo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
