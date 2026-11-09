# Clickable prototype

`index.html` is a **self-contained, interactive prototype** of the redesigned IA (no build, no
dependencies — open it in any browser). It is **mock data**, meant to make the design in
[`../../settings-navigation-redesign.md`](../../settings-navigation-redesign.md) and the
[`../spec/`](../spec/) tangible — not the live app.

## What it demonstrates

- The **three-zone shell**: account switcher (left), the six verb destinations (center), verbs + ambient
  risk (right).
- **Money-reality word-classes** (`PAPER · practice` / `LIVE · real money` / `TEST · sandbox`) and the
  **Live real-money treatment** (red viewport hairline + banner) — switch to the Robinhood account to see it.
- **STOP ≠ Flatten** (click STOP), **Run-once stamped with its target**, and the **⌘K command palette**.
- **Approvals** with the policy-gate checklist, the **MODE badge on the Approve button**, and a
  **cross-account wash-sale lockout named with provenance**.
- **Strategy** consolidated to one editable home; **Guardrails** with the Essentials → Advanced disclosure
  and per-control **scope pills** (`THIS ACCOUNT` / `ALL ACCOUNTS`).
- **Settings** split **by scope first** (user-global menu vs an account-scoped signpost).
- **Fleet view** (pick "All accounts") — read-and-triage, with **STOP all (Live + Paper), Test excluded**.

## Try it

Open `index.html` and: click the **account chip** (top-left) to switch accounts — switching to the
Robinhood **Live** account re-scopes everything and turns the frame red; open **Guardrails** and toggle
**Show advanced**; open **Approvals** on the Live account to see the mode-stamped approve button and the
wash-sale card; press **⌘K**.

## Deep links (for sharing a specific screen)

Append query params: `?acct=<roth|taxable|rh|test|fleet>&dest=<dashboard|approvals|scan|strategy|guardrails|results|settings>&adv=1`.
Example: `index.html?acct=rh&dest=approvals` opens the Live-account approvals screen.

> Fidelity note: this is an IA/flow prototype, not the production design system. Interactions are
> illustrative; the buildable detail (states, fields, data contracts) lives in [`../spec/`](../spec/).
