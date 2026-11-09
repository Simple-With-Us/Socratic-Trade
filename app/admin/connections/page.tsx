import { ConnectionsHealthClient } from "./connections-health-client";

export const metadata = { title: "API Connections" };

export default function ConnectionsPage() {
  return <ConnectionsHealthClient />;
}
