import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDesk, isDeskServiceActive } from "@/lib/desk";
import DeskView from "@/components/DeskView";

export const metadata: Metadata = {
  title: "Your Desk",
  robots: { index: false },
};

// Legacy desk links (pre-auth UUID desks) keep working.
export default async function DeskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const desk = await getDesk(id);
  if (!desk || !isDeskServiceActive(desk)) notFound();
  return <DeskView desk={desk} />;
}
