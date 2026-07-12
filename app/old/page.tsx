import type { Metadata } from "next";
import { DashboardClient } from "../dashboard-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Old Dashboard",
  description: "Legacy Socratic Trade dashboard retained while the new autonomy desk becomes the primary app."
};

export default async function OldDashboardPage() {
  return <DashboardClient initialSnapshot={null} />;
}
