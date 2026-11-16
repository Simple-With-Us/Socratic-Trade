// design-sync bundle entry (durable input). Re-exports both primitive design
// systems under a single namespace. The app/console set is renamed Con* so its
// Card/Chip/Dot/Field don't collide with the app/ui set in the shared
// window.SocraticTradeDS namespace. See .design-sync/NOTES.md for the full why.
//
// The UI group was slimmed 2026-07-16 alongside app/ui/primitives.tsx: that
// file now only implements Card, Button, and buttonClass (its real app
// consumers) — every other former export (IconButton, PanelHeader, Chip, Dot,
// Switch, Segmented, Tabs, Field, StatTile, EmptyState, inputClass, ICON) was
// deleted as dead code and is no longer re-exported here.

// ── app/ui primitives (group: UI) ──────────────────────────────────────────
export {
  Button,
  Card,
  // Styling helper (not a component) — available on window.SocraticTradeDS for
  // composing button-looking links.
  buttonClass
} from "../../app/ui/primitives";

// ── app/console primitives (group: Console), renamed Con* ───────────────────
export {
  Card as ConCard,
  Btn as ConBtn,
  Chip as ConChip,
  LiveTag as ConLiveTag,
  Dot as ConDot,
  Meter as ConMeter,
  Stat as ConStat,
  Field as ConField,
  TextInput as ConTextInput,
  NumInput as ConNumInput,
  RawNumInput as ConRawNumInput,
  Select as ConSelect,
  TextArea as ConTextArea,
  Toggle as ConToggle,
  Empty as ConEmpty,
  Dash as ConDash,
  Ago as ConAgo,
  SignedText as ConSignedText
} from "../../app/console/ui/primitives";
