"use client";

import { AnimatePresence, motion, useDragControls } from "motion/react";
import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { cn } from "./cn";

function useDismissable(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => ref.current?.focus(), 0);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const focusables = ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) {
        e.preventDefault();
        ref.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey ? active === first || active === ref.current : active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

// Larger modals (Settings, System Help, Accounts) fill the whole screen on mobile so their content
// is never clipped on the right edge and there is room to lay options out without cramping.
const MOBILE_FULL = "max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0";
const sizeClass = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: `max-w-3xl ${MOBILE_FULL}`,
  xl: `max-w-5xl ${MOBILE_FULL}`,
  full: `max-w-[95vw] h-[95vh] ${MOBILE_FULL}`
};

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  headerAction,
  size = "md",
  footer,
  children
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  headerAction?: React.ReactNode;
  size?: keyof typeof sizeClass;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useDismissable(open, onClose);
  const dragControls = useDragControls();
  const constrainRef = useRef<HTMLDivElement>(null);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={constrainRef}
          className="fixed inset-0 z-[1300] flex items-center justify-center p-0 sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Backdrop — click to close */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-scrim"
            onClick={onClose}
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            drag
            dragControls={dragControls}
            dragConstraints={constrainRef}
            dragMomentum={false}
            dragElastic={0}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-white dark:bg-zinc-950 shadow-[var(--shadow-lg)]",
              sizeClass[size]
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — drag handle */}
            <div
              className="flex cursor-move select-none items-center justify-between gap-3 border-b border-line px-5 py-4"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {icon && <span className="text-accent">{icon}</span>}
                <div className="min-w-0">
                  {typeof title === "string" ? (
                    <h3 className="text-base font-semibold text-fg">{title}</h3>
                  ) : (
                    <div className="min-w-0">{title}</div>
                  )}
                  {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
                {headerAction}
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="cursor-pointer inline-flex h-8 w-8 max-sm:h-11 max-sm:w-11 touch-manipulation items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function SlideOver({
  open,
  onClose,
  title,
  subtitle,
  ariaLabel,
  icon,
  actions,
  width = "max-w-xl",
  children
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: string;
  ariaLabel?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  width?: string;
  children: React.ReactNode;
}) {
  const ref = useDismissable(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed left-0 right-0 bottom-0 z-[900]"
          style={{ top: "var(--header-height, 64px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-scrim" onClick={onClose} />
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel ?? (typeof title === "string" ? title : "Panel")}
            tabIndex={-1}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute right-0 top-0 flex h-full w-full max-[400px]:max-w-[calc(100vw-2rem)] flex-col border-l border-line bg-white dark:bg-zinc-950 shadow-[var(--shadow-lg)]",
              width
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div className="flex items-center gap-2.5 min-w-0">
                {icon && <span className="text-accent">{icon}</span>}
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-fg">{title}</h3>
                  {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {actions}
                <button
                  onClick={onClose}
                  aria-label="Close panel"
                  className="inline-flex h-8 w-8 max-sm:h-11 max-sm:w-11 touch-manipulation items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

import { Button } from "./primitives";

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  tone = "danger"
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">{body}</p>
    </Modal>
  );
}
