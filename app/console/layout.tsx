import "./console.css";
import type { Metadata, Viewport } from "next";
import { ConsoleShell } from "./components/shell";

export const metadata: Metadata = {
  description: "Socratic Trade autonomy desk: live thesis, decision trace, evidence, coaching, and framework learning."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // SSR default matches --con-bg light. applyDocumentTheme rewrites this meta
  // to #0a0a0a when the resolved theme is dark, including a system choice.
  themeColor: "#f1f4f6"
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
