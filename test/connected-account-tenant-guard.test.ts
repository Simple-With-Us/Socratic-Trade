import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Finding D: upsertConnectedAccount must not let one user overwrite another user's account row by
// supplying that row's `id`. The Test account id is deterministic (`test-<userId>`, derivable from a
// known email), so without a guard a family member could rewrite another's broker/key fields.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tenantguard-${randomUUID()}.db`)}`;
});

describe("upsertConnectedAccount — cross-tenant write guard (Finding D)", () => {
  it("refuses to overwrite another user's account row that shares the same id", async () => {
    const db = await import("../src/lib/db");
    const sharedId = "test-victim"; // mimics the deterministic, guessable Test-account id

    // Victim owns the row with real broker creds.
    db.upsertConnectedAccount({
      id: sharedId, userId: "victim", broker: "alpaca", environment: "paper",
      accountNumber: "PA-VICTIM", label: "Victim Alpaca", apiKey: "VICTIM_KEY", apiSecret: "VICTIM_SECRET", isActive: true
    });

    // Attacker tries to hijack the same id with their own broker/keys.
    db.upsertConnectedAccount({
      id: sharedId, userId: "attacker", broker: "robinhood", environment: "live",
      accountNumber: "ATTACKER", label: "pwned", apiKey: "ATTACKER_KEY", apiSecret: "ATTACKER_SECRET", isActive: true
    });

    // The victim's row is untouched — broker, account number, and label all intact (the UPDATE branch
    // was skipped, so api_key/api_secret were not rewritten either). listConnectedAccounts masks the
    // decrypted secret, so we assert on the non-secret columns that prove the row wasn't overwritten.
    const victimRows = db.listConnectedAccounts("victim");
    expect(victimRows).toHaveLength(1);
    expect(victimRows[0].id).toBe(sharedId);
    expect(victimRows[0].broker).toBe("alpaca");
    expect(victimRows[0].accountNumber).toBe("PA-VICTIM");
    expect(victimRows[0].label).toBe("Victim Alpaca");

    // The attacker gets no row under that id — the conflicting write silently no-ops.
    expect(db.listConnectedAccounts("attacker")).toHaveLength(0);
  });

  it("still allows the legitimate owner to update their own account", async () => {
    const db = await import("../src/lib/db");
    const id = randomUUID();
    db.upsertConnectedAccount({ id, userId: "owner", broker: "alpaca", environment: "paper", accountNumber: "PA1", label: "before", isActive: true });
    db.upsertConnectedAccount({ id, userId: "owner", broker: "alpaca", environment: "paper", accountNumber: "PA1", label: "after", isActive: true });
    const rows = db.listConnectedAccounts("owner");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("after");
  });
});
