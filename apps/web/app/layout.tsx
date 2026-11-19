import type { ReactNode } from "react";

export const metadata = {
  title: "SignalTrail",
  description: "Evidence-backed incident investigation",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
