import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import AmmFox from "@/components/AmmFox";
import Tri from "@/components/Tri";
import DeskPriorityStack from "@/components/DeskPriorityStack";
import { getDesk, isDeskServiceActive } from "@/lib/desk";
import { buildDeskPriorityCards } from "@/lib/deskPresentation";

export const metadata: Metadata = {
  title: "Your Desk",
  robots: { index: false },
};

function etGreeting(): string {
  const h = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
    10,
  );
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

export default async function MyDesk() {
  const { userId } = await auth();
  if (!userId) redirect("/desk/new");
  const desk = await getDesk(userId);
  if (!desk) redirect("/desk/new");
  if (!isDeskServiceActive(desk)) redirect("/desk/new?purchase=pro");

  const user = await currentUser();
  const name = user?.firstName ?? desk.email.split("@")[0];
  const renderedAt = new Date();
  const cards = await buildDeskPriorityCards(desk, renderedAt);

  const shiftNum = Math.max(1, Math.floor((renderedAt.getTime() - desk.createdAt) / 86_400_000) + 1);
  const dateLabel = renderedAt.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).toUpperCase();

  return (
    <div className="pt-3 pb-10 sm:pt-4">
      <section className="flex min-h-[72px] items-start justify-between gap-5 sm:min-h-[72px]">
        <div>
          <span className="pp-chip">{`SHIFT ${shiftNum} · ${dateLabel}`}</span>
          <h1 className="pp-disp mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
            {etGreeting()}, {name}<Tri size="0.34em" />
          </h1>
        </div>
        <div className="flex items-start gap-2 sm:gap-5">
          <div className="hidden -translate-y-2 sm:block">
            <AmmFox size={64} />
          </div>
          <Link href="/desk/new" className="pp-chip mt-2 whitespace-nowrap hover:opacity-70">
            + ADD A COMPANY
          </Link>
        </div>
      </section>

      <DeskPriorityStack cards={cards} />
    </div>
  );
}
