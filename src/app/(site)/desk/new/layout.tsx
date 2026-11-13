import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Your AMM Desk",
  robots: { index: false, follow: false },
};

export default function NewDeskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
