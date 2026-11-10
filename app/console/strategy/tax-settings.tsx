"use client";

/** Tax treatment — account-scoped tax configuration (taxation type, wash-sale
 *  handling, estimated rates, net-of-tax display). Rendered on the Guardrails
 *  page (app/console/guardrails/page.tsx), directly above the Advanced
 *  rulebook's Tax rules group that references it, because it is per-account
 *  like everything else there: policy.taxSettings is an account-level policy
 *  field, so the values follow the account you're viewing, not your login.
 *  Moved out of Settings in the 2026-07-10 IA restructure (Settings is
 *  global-only), then from Strategy to Guardrails in the 2026-07-16 IA
 *  restructure. This module itself stays put — only the page that imports it
 *  changed. Self-contained (own auto-save) — never wired into the
 *  PolicySaveBar draft machinery Guardrails uses for everything else. */

import { useState } from "react";
import type { IraWashSaleHandling, TaxationType } from "@/lib/types";
import { savePolicy } from "../lib/api";
import { activeConnectedAccount } from "../lib/derive";
import { resolveTaxRateCommit } from "../lib/number-commit";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { Card, Chip, Field, RawNumInput, Select, Toggle } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";

const TAXATION_LABEL: Record<TaxationType, string> = {
  taxable: "taxable brokerage",
  roth_ira: "Roth IRA",
  traditional_ira: "traditional IRA"
};

type TaxDraft = Partial<{
  taxationType: TaxationType;
  washSaleGuard: boolean;
  iraWashSaleHandling: IraWashSaleHandling;
  shortTermRatePct: number;
  longTermRatePct: number;
  subtractFromResults: boolean;
}>;

export function TaxSettingsCard() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  // Sticky optimistic overlay: each field's own edits persist immediately; on a
  // write failure useAutoSave's onError restores just that field.
  const [draft, setDraft] = useState<TaxDraft>({});
  const [rawRates, setRawRates] = useState<{ shortTermRatePct?: string; longTermRatePct?: string }>({});
  if (!snapshot) return null;

  const current = snapshot.policy.taxSettings;

  // Persist one tax field. Selects/toggles call on change; number rates call on blur
  // (their transient text lives in `rawRates` until then). `next` is the value already
  // applied to `draft` optimistically; `prev` is what to restore if the write fails.
  const commit = <K extends keyof TaxDraft>(key: K, next: TaxDraft[K], prev: TaxDraft[K]) => {
    autoSave.save(() => savePolicy({ taxSettings: { [key]: next } }, snapshot.policy.connectedAccountId).then(() => refresh()), {
      onError: () => setDraft((d) => ({ ...d, [key]: prev }))
    });
  };

  const commitRate = (key: "shortTermRatePct" | "longTermRatePct", defaultVal: number) => {
    const raw = rawRates[key];
    setRawRates((r) => {
      if (!(key in r)) return r;
      const copy = { ...r };
      delete copy[key];
      return copy;
    });
    if (raw === undefined) return;
    const saved = current?.[key] ?? defaultVal;
    const next = resolveTaxRateCommit(raw, saved);
    if (next === null) return;
    setDraft((d) => ({ ...d, [key]: next }));
    commit(key, next, saved);
  };

  // The connected account's own taxationType (set when it was linked) WINS over
  // policy.taxSettings server-side (dashboard tax summary reads
  // activeAccount.taxationType ?? policy.taxSettings.taxationType), and no API
  // exists to edit it here — so when the account defines it, show it read-only
  // instead of a select whose "saved" value would be silently overridden.
  const accountTaxationType = activeConnectedAccount(snapshot)?.taxationType;
  const taxation: TaxationType = accountTaxationType ?? draft?.taxationType ?? current?.taxationType ?? "taxable";
  const isIra = taxation === "roth_ira" || taxation === "traditional_ira";
  const washSaleGuard: boolean = draft?.washSaleGuard ?? current?.washSaleGuard ?? true;
  const iraWashSaleHandling: IraWashSaleHandling = draft?.iraWashSaleHandling ?? current?.iraWashSaleHandling ?? "disregard";
  const subtractFromResults: boolean = draft?.subtractFromResults ?? current?.subtractFromResults ?? false;
  const shortTermRatePct: number = draft?.shortTermRatePct ?? current?.shortTermRatePct ?? 24;
  const longTermRatePct: number = draft?.longTermRatePct ?? current?.longTermRatePct ?? 15;

  return (
    <Card
      title="Tax treatment"
      action={
        <div className="flex items-center gap-2">
          <Chip
            tone="muted"
            title="Stored on the account itself, like everything on this page — switch scope and you'll see that account's values instead."
          >
            THIS ACCOUNT
          </Chip>
          <SaveStatus status={autoSave.status} />
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {accountTaxationType ? (
          <Field
            label="Account type"
            hint="Set on the connected account when it was linked — that value always wins over anything saved here, and this console can't change it yet."
          >
            <div className="con-input flex items-center bg-[color:var(--con-surface-2)] text-[color:var(--con-muted)]">
              {TAXATION_LABEL[accountTaxationType] ?? accountTaxationType}
            </div>
          </Field>
        ) : (
          <Field label="Account type" hint="IRAs zero the rates and skip the per-account wash-sale guard automatically." htmlFor="taxtype">
            <Select
              id="taxtype"
              value={taxation}
              disabled={autoSave.saving}
              title="How gains in this account are taxed.  Drives the tax estimates and the wash-sale handling."
              onChange={(e) => {
                const prev = draft.taxationType;
                const next = e.target.value as TaxationType;
                setDraft((d) => ({ ...d, taxationType: next }));
                commit("taxationType", next, prev);
              }}
            >
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short-term rate %" htmlFor="st-rate">
            <RawNumInput
              id="st-rate"
              value={rawRates.shortTermRatePct ?? String(shortTermRatePct)}
              emptyValue={shortTermRatePct}
              title="Your estimated tax rate on gains from positions held one year or less.  Used only for the tax estimates — not advice.  Saves when you click away."
              onValueChange={(_parsed, raw) => setRawRates((r) => ({ ...r, shortTermRatePct: raw }))}
              onBlur={() => commitRate("shortTermRatePct", 24)}
            />
          </Field>
          <Field label="Long-term rate %" htmlFor="lt-rate">
            <RawNumInput
              id="lt-rate"
              value={rawRates.longTermRatePct ?? String(longTermRatePct)}
              emptyValue={longTermRatePct}
              title="Your estimated tax rate on gains from positions held more than one year.  Used only for the tax estimates — not advice.  Saves when you click away."
              onValueChange={(_parsed, raw) => setRawRates((r) => ({ ...r, longTermRatePct: raw }))}
              onBlur={() => commitRate("longTermRatePct", 15)}
            />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        {isIra ? (
          <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[length:var(--con-fs-sm)] font-semibold">Same-IRA wash sales</div>
                <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
                  Ignored automatically.  This account has no taxable loss deduction inside the IRA, so Block / Ask /
                  Auto is not the relevant control.
                </p>
              </div>
              <Chip tone="pos">not applicable</Chip>
            </div>
            <div className="mt-3 max-w-md">
              <Field
                label="Taxable-loss rebuy inside this IRA"
                hint="Only applies when another taxable account sold the same symbol at a loss in the last 30 days.  Ignore (default) does not constrain this IRA.  Auto lets Green weigh it, then proceeds.  Block refuses.  Minimum loss in Tax rules below is optional (blank = every loss)."
                htmlFor="ira-wash-sale"
              >
                <Select
                  id="ira-wash-sale"
                  value={iraWashSaleHandling}
                  disabled={autoSave.saving}
                  title="Controls cross-account IRA replacement buys after a taxable loss.  Same-IRA wash sales are already ignored.  Default: ignore/disregard and annotate."
                  onChange={(e) => {
                    const prev = draft.iraWashSaleHandling;
                    const next = e.target.value as IraWashSaleHandling;
                    setDraft((d) => ({ ...d, iraWashSaleHandling: next }));
                    commit("iraWashSaleHandling", next, prev);
                  }}
                >
                  <option value="disregard">Ignore (default)</option>
                  <option value="auto">Auto — weigh it, then proceed</option>
                  <option value="block">Block cross-account IRA replacement buys</option>
                </Select>
              </Field>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-between gap-4 rounded-control px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
            title="On: buying back a symbol you sold at a loss in the last 30 days is blocked, so the loss stays deductible."
          >
            <div>
              <div className="text-[length:var(--con-fs-sm)] font-semibold">Taxable-account wash-sale guard</div>
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Blocks rebuying a symbol this taxable account closed at a loss within 30 days.  A taxable-account loss
                can also lock replacement buys across your other accounts, including IRAs.
              </p>
            </div>
            <Toggle
              checked={washSaleGuard}
              disabled={autoSave.saving}
              onChange={(next) => {
                const prev = draft.washSaleGuard;
                setDraft((d) => ({ ...d, washSaleGuard: next }));
                commit("washSaleGuard", next, prev);
              }}
              label="Wash-sale guard"
            />
          </div>
        )}
        <div
          className="flex items-center justify-between gap-4 rounded-control px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
          title="On: P&L on the Results screen is shown after subtracting estimated taxes at the rates above."
        >
          <div>
            <div className="text-[length:var(--con-fs-sm)] font-semibold">Show results net of estimated tax</div>
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Estimates only — not tax advice.</p>
          </div>
          <Toggle
            checked={subtractFromResults}
            disabled={autoSave.saving}
            onChange={(next) => {
              const prev = draft.subtractFromResults;
              setDraft((d) => ({ ...d, subtractFromResults: next }));
              commit("subtractFromResults", next, prev);
            }}
            label="Subtract tax from results"
          />
        </div>
      </div>
    </Card>
  );
}
