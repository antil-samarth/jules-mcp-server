import type { ReactNode } from "react";

export const metadata = {
  title: "Jules MCP Server",
  description: "Authenticated MCP bridge to the Google Jules API.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
