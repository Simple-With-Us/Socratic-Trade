"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/overlays";

interface ConfirmationModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  symbol: string;
  side: string;
  quantity?: number;
  dollarAmount?: number;
  price?: number;
  estimatedNotional?: number;
  accountNumber?: string;
}

const CONFIRMATION_PHRASE_PREFIX = "APPROVE LIVE";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatShareQuantity(qty: number): string {
  if (Number.isInteger(qty)) return qty.toString();
  return qty.toFixed(4).replace(/\.?0+$/, "");
}

export function ConfirmationModal({
  open,
  onClose,
  onConfirm,
  symbol,
  side,
  quantity,
  dollarAmount,
  price,
  estimatedNotional,
  accountNumber
}: ConfirmationModalProps) {
  const expectedPhrase = `${CONFIRMATION_PHRASE_PREFIX} ${symbol.trim().toUpperCase()}`;
  const [inputValue, setInputValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setInputValue("");
      setConfirmed(false);
      // Focus the input after the modal transition settles
      const timeout = setTimeout(() => {
        inputRef.current?.focus();
      }, 200);
      return () => clearTimeout(timeout);
    }
  }, [open]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && inputValue.trim().toUpperCase() === expectedPhrase) {
        e.preventDefault();
        setConfirmed(true);
        // Brief delay so the user sees the confirmation before the modal closes
        setTimeout(() => {
          onConfirm();
        }, 400);
      }
    },
    [inputValue, expectedPhrase, onConfirm]
  );

  const phraseMatches = inputValue.trim().toUpperCase() === expectedPhrase;

  const sideLabel = side === "buy" ? "Buy" : side === "sell" ? "Sell" : side === "short" ? "Short" : "Cover";
  const sideColor =
    side === "buy" || side === "cover"
      ? "text-up"
      : "text-down";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={confirmed ? "Trade Confirmed" : "Confirm Live Trade"}
      subtitle={confirmed ? "Executing your order…" : undefined}
      icon={confirmed ? <Check size={20} /> : <AlertTriangle size={20} />}
      size="sm"
      footer={
        confirmed ? null : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!phraseMatches}
              aria-disabled={!phraseMatches}
              onClick={() => {
                setConfirmed(true);
                setTimeout(() => {
                  onConfirm();
                }, 400);
              }}
              className="h-9 rounded-lg bg-down px-4 text-sm font-medium text-down-fg shadow-sm transition-colors hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Confirm Trade
            </button>
          </>
        )
      }
    >
      {confirmed ? (
        <div className="flex flex-col items-center justify-center py-4 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-up/20">
            <Check size={20} className="text-up" />
          </div>
          <p className="text-sm font-medium text-fg">Order is being placed for {symbol}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Warning block */}
          <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-down" />
              <div className="text-sm text-fg">
                <p className="font-semibold">You are about to place a real brokerage order</p>
                <p className="mt-1 text-xs text-muted">
                  This will submit a live order to your broker. Funds will leave your account and you
                  will hold a real position. Review the details below carefully.
                </p>
              </div>
            </div>
          </div>

          {/* Trade details grid */}
          <div className="rounded-lg border border-line bg-surface-2/45 p-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <span className="text-faint">Symbol</span>
                <p className="font-semibold text-fg">{symbol.trim().toUpperCase()}</p>
              </div>
              <div>
                <span className="text-faint">Action</span>
                <p className={sideColor + " font-semibold"}>{sideLabel}</p>
              </div>
              {quantity !== undefined && (
                <div>
                  <span className="text-faint">Quantity</span>
                  <p className="font-semibold text-fg">{formatShareQuantity(quantity)} shares</p>
                </div>
              )}
              {dollarAmount !== undefined && (
                <div>
                  <span className="text-faint">Dollar amount</span>
                  <p className="font-semibold text-fg">{formatCurrency(dollarAmount)}</p>
                </div>
              )}
              {price !== undefined && (
                <div>
                  <span className="text-faint">Price</span>
                  <p className="font-semibold text-fg">{formatCurrency(price)}</p>
                </div>
              )}
              {estimatedNotional !== undefined && (
                <div>
                  <span className="text-faint">Est. notional</span>
                  <p className="font-semibold text-fg">{formatCurrency(estimatedNotional)}</p>
                </div>
              )}
              {accountNumber && (
                <div className="col-span-2">
                  <span className="text-faint">Account</span>
                  <p className="font-mono text-[13px] text-fg">{accountNumber}</p>
                </div>
              )}
            </div>
          </div>

          {/* Typed confirmation input */}
          <div className="space-y-2">
            <label htmlFor="live-confirmation-input" className="block text-xs font-medium text-muted">
              Type <code className="rounded bg-surface-3 px-1 py-0.5 text-[12px] font-mono text-fg">{expectedPhrase}</code> to confirm
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="live-confirmation-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={expectedPhrase}
                aria-label={`Type ${expectedPhrase} to confirm`}
                aria-describedby="confirmation-hint"
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint/70 focus:border-accent focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {phraseMatches && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-up">
                  <Check size={16} />
                </span>
              )}
            </div>
            <p id="confirmation-hint" className="text-[11px] text-faint">
              Press <kbd className="rounded border border-line bg-surface-2 px-1 text-[10px]">Enter</kbd> to confirm when ready.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
