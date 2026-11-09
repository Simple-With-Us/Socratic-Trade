import { afterEach, describe, expect, it } from "vitest";
import { assertSecretsManagerIfRequired, secretsManagerProblem, secretsSource } from "../src/lib/secrets-source";

const saved = { require: process.env.REQUIRE_SECRETS_MANAGER, source: process.env.SECRETS_SOURCE };
function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  restore("REQUIRE_SECRETS_MANAGER", saved.require);
  restore("SECRETS_SOURCE", saved.source);
});

describe("secretsSource", () => {
  it("maps the runner marker and defaults to 'env'", () => {
    delete process.env.SECRETS_SOURCE;
    expect(secretsSource()).toBe("env");
    process.env.SECRETS_SOURCE = "Infisical"; // case-insensitive
    expect(secretsSource()).toBe("infisical");
    process.env.SECRETS_SOURCE = "gcp"; // GCP path removed → no longer a recognized manager
    expect(secretsSource()).toBe("env");
    process.env.SECRETS_SOURCE = "bogus";
    expect(secretsSource()).toBe("env");
  });
});

describe("secretsManagerProblem / assertSecretsManagerIfRequired", () => {
  it("is a no-op when not required (default off)", () => {
    delete process.env.REQUIRE_SECRETS_MANAGER;
    delete process.env.SECRETS_SOURCE;
    expect(secretsManagerProblem()).toBeNull();
    expect(() => assertSecretsManagerIfRequired()).not.toThrow();
  });

  it("trips when required but launched plainly (no manager)", () => {
    process.env.REQUIRE_SECRETS_MANAGER = "1";
    delete process.env.SECRETS_SOURCE;
    expect(secretsManagerProblem()).toMatch(/REQUIRE_SECRETS_MANAGER/);
    expect(() => assertSecretsManagerIfRequired()).toThrow(/secrets/i);
  });

  it("passes when required AND launched via a manager runner", () => {
    process.env.REQUIRE_SECRETS_MANAGER = "true";
    process.env.SECRETS_SOURCE = "infisical";
    expect(secretsManagerProblem()).toBeNull();
    expect(() => assertSecretsManagerIfRequired()).not.toThrow();
  });

  it("treats falsy REQUIRE values as off", () => {
    process.env.REQUIRE_SECRETS_MANAGER = "0";
    delete process.env.SECRETS_SOURCE;
    expect(secretsManagerProblem()).toBeNull();
  });
});
