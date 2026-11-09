import { ConTextArea } from "socratic-trade-dashboard";

export const TradeThesis = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextArea
      rows={4}
      defaultValue={"Earnings beat + raised guidance. Entering on breakout above 20d high with a 2% risk cap."}
    />
  </div>
);

export const PostMortemNote = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextArea rows={3} placeholder="What worked, what didn't, and what to change next time" />
  </div>
);

export const DisabledAuditNote = () => (
  <div className="console-root" style={{ padding: 8, maxWidth: 280 }}>
    <ConTextArea rows={3} defaultValue="Closed by policy: daily loss cap reached." disabled />
  </div>
);
