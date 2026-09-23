import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Canadian Housing Agent | Canada Housing Atlas",
  description:
    "Explore Canadian asking prices on an interactive city atlas. Compare cities and ask questions about the research sample.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
