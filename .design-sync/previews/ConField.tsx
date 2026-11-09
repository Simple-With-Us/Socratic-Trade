import { ConField, ConTextInput, ConNumInput, ConSelect } from "socratic-trade-dashboard";

export const OrderSizeField = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConField label="Order size (shares)" hint="Max position size is capped by your risk policy.">
      <ConNumInput defaultValue={25} placeholder="0" />
    </ConField>
  </div>
);

export const ThesisTagField = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConField label="Trade thesis tag" hint="Short label used to group this trade in the learning loop.">
      <ConTextInput defaultValue="earnings-beat-momentum" placeholder="e.g. earnings-beat-momentum" />
    </ConField>
  </div>
);

export const AccountSelectField = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConField label="Execution account" hint="Orders route to whichever account is selected here.">
      <ConSelect defaultValue="alpaca-main">
        <option value="alpaca-main">Alpaca — Main Brokerage</option>
        <option value="alpaca-sandbox">Alpaca — Sandbox</option>
        <option value="robinhood-retirement">Robinhood — Retirement</option>
      </ConSelect>
    </ConField>
  </div>
);
