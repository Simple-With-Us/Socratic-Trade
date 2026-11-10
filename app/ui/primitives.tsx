"use client";

/* ── app/ui/primitives.tsx ────────────────────────────────────────────────
 * The public/marketing renderer's primitive layer — deliberately distinct
 * from the console `con-*` system per the "two renderers, one brand core"
 * direction (docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md
 * §1; per-page decision in
 * docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md).
 * Brand accent + radius canon are shared via `--brand-accent` / `--radius-card`
 * (docs/design/visual-system.md).
 *
 * Slimmed 2026-07-16 to its real consumers (Card, Button, buttonClass);
 * deleted primitives live in git history, and the console system is the home
 * of the full cockpit primitive set.
 */

import { cn } from "./cn";

/* ── Button ──────────────────────────────────────────────────────────────── */
type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "accentSoft";
type ButtonSize = "sm" | "md";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors touch-manipulation disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 shadow-sm",
  danger: "bg-neg text-neg-fg hover:brightness-110 shadow-sm",
  ghost: "border border-line bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-2 text-fg hover:bg-surface-3",
  accentSoft: "bg-accent/12 text-accent hover:bg-accent/20 border border-accent/20"
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 max-sm:min-h-11 px-3 text-[13px]",
  md: "h-10 max-sm:min-h-11 px-4 text-sm"
};

/** Button styling as a class string, for when you need button looks on a non-button
 *  element (e.g. an `<a>` link) without nesting a `<button>` inside an `<a>`. */
export function buttonClass(opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  const { variant = "primary", size = "md", className } = opts;
  return cn(buttonBase, buttonVariants[variant], buttonSizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass({ variant, size, className })} {...props} />;
}

/* ── Card / Panel ────────────────────────────────────────────────────────── */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border border-line bg-surface/80 backdrop-blur-sm", className)}
      {...props}
    />
  );
}
