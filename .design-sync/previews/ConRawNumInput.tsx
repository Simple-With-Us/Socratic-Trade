import { ConRawNumInput } from "socratic-trade-dashboard";

export const LimitPriceEntry = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConRawNumInput value="150.25" onValueChange={() => {}} emptyValue={0} placeholder="0.00" />
  </div>
);

export const StopLossEntry = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConRawNumInput value="142.10" onValueChange={() => {}} emptyValue={0} placeholder="0.00" />
  </div>
);

export const RiskCapPercent = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConRawNumInput value="2.5" onValueChange={() => {}} emptyValue={0} placeholder="0.0" />
  </div>
);

export const DisabledSharesEntry = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConRawNumInput value="100" onValueChange={() => {}} emptyValue={0} disabled />
  </div>
);
