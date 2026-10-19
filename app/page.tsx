import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { landingPageEnabled } from "@/lib/landing-page";

export const dynamic = "force-dynamic";

// The public marketing hosts land on the /welcome product page. The middleware
// already routes the apex "/" by host (and by whether the visitor is signed in),
// so this is the fallback for any path that reaches the route itself.
const MARKETING_HOSTS = new Set([
  "socratictrade.com",
  "www.socratictrade.com",
  "socratic.trade",
  "www.socratic.trade"
]);

export default async function HomePage() {
  const host = (await headers()).get("host")?.toLowerCase().split(":")[0] ?? "";
  // admin.socratictrade.com lands on the operator admin hub; every other host goes to the console.
  // Inert until ADMIN_HOST is set (e.g. "admin.socratictrade.com"). Auth still applies to /admin.
  const adminHost = process.env.ADMIN_HOST?.trim().toLowerCase();
  if (adminHost && host === adminHost) redirect("/admin");
  // Only send visitors to /welcome while the marketing pages are on.  With the
  // landing page switched off, /welcome 404s, so an unconditional redirect would
  // turn the apex into a dead end instead of the login page.
  if (MARKETING_HOSTS.has(host) && landingPageEnabled()) redirect("/welcome");
  redirect("/console");
}
