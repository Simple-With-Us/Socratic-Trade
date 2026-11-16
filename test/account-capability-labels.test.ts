import { describe, expect, it } from "vitest";
import {
  accountFractionalSharesLabel,
  accountOptionsTradingLabel,
  accountSessionHoursLabel
} from "../app/console/lib/labels";

describe("account capability chip labels — Title Case to match Connected / Disabled", () => {
  it("labels fractional vs whole shares in Title Case", () => {
    expect(accountFractionalSharesLabel(true)).toBe("Enabled");
    expect(accountFractionalSharesLabel(false)).toBe("Whole Shares");
    expect(accountFractionalSharesLabel(undefined)).toBe("Whole Shares");
  });

  it("labels session hours in Title Case", () => {
    expect(accountSessionHoursLabel({ overnightHours: true, extendedHours: true })).toBe(
      "Regular + Extended + Overnight"
    );
    expect(accountSessionHoursLabel({ extendedHours: true })).toBe("Regular + Extended");
    expect(accountSessionHoursLabel({ extendedHours: false })).toBe("Regular Only");
    expect(accountSessionHoursLabel(undefined)).toBe("Regular Only");
  });

  it("labels options access in Title Case", () => {
    expect(accountOptionsTradingLabel({ optionsOrders: true, optionsLevel: 3 })).toBe("Orders · Level 3");
    expect(accountOptionsTradingLabel({ optionsTrading: true, optionsLevel: 2 })).toBe(
      "Positions Only · Level 2"
    );
    expect(accountOptionsTradingLabel({ optionsTrading: false })).toBe("Disabled");
  });
});
