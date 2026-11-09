import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** PWA removed (owner 2026-08-16/17).  Use the native iOS app or the website
 *  at /console (desktop and phone widths).  Do not rebuild a PWA here. */
export default function MobilePage() {
  redirect("/console");
}
