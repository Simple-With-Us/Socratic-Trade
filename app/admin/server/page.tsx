import { ServerMetricsClient } from "./server-metrics-client";

export const metadata = {
  title: "Server Stats — Socratic Trade"
};

export default function ServerMetricsPage() {
  return <ServerMetricsClient />;
}
