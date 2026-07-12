import "./globals.css";
import type { Metadata, Viewport } from "next";
import { ThemeProvider, themeInitScript } from "./ui/theme";
import { Toaster } from "sonner";
import { GlobalErrorToasts } from "./ui/global-error-toasts";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://socratictrade.com"),
  title: {
    default: "Socratic Trade",
    template: "%s · Socratic Trade"
  },
  description:
    "Socratic Trade is an autonomous market-reasoning system that forms theses, acts within delegated authority, shows its evidence and dissent, and learns from outcomes. Not investment advice.",
  applicationName: "Socratic Trade",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Socratic Trade",
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg"
  },
  keywords: [
    "AI trading agent",
    "autonomous trading software",
    "algorithmic trading system",
    "market reasoning tool",
    "trading decision journal"
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/",
    title: "Socratic Trade",
    description:
      "Autonomous market reasoning with visible theses, evidence, dissent, actions, and outcome learning. Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Socratic Trade",
    description: "Autonomous market reasoning with visible decisions and outcome learning. Not investment advice."
  },
  // Default = NOINDEX. Only allow indexing when explicitly opted in (the app is private by default).
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

// viewport-fit=cover lets the page extend under the notch/home indicator; the
// safe-area-inset padding in globals.css then keeps content clear of them.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080b12"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
          <GlobalErrorToasts />
          <Toaster theme="system" position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
