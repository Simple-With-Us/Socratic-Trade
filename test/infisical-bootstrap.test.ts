import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM operator helper, intentionally dependency-free (single-line so the directive covers the specifier)
import { DEFAULT_APP_PROJECT_ID, DEFAULT_SHARED_PROJECT_ID, INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS, INFISICAL_FINAL_APP_MASK_KEYS, InfisicalBootstrapError, prepareInfisicalBootstrapEnvironment, resolveInfisicalBootstrap } from "../scripts/infisical-bootstrap-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextEnvEntry = createRequire(import.meta.url).resolve("@next/env");
const tempRoots: string[] = [];
const EXPECTED_FINAL_MASK_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFIISICAL_ST_CLIENT_ID",
  "INFIISICAL_ST_CLIENT_SECRET",
  "INFISICAL_ST_CLIENT_ID",
  "INFISICAL_ST_CLIENT_SECRET",
  "INFISICAL_SHARED_CLIENT_ID",
  "INFISICAL_SHARED_CLIENT_SECRET",
  "INFISICAL_CT_SHARED_CLIENT_ID",
  "INFISICAL_CT_SHARED_CLIENT_SECRET",
  "INFISICAL_APP_CLIENT_ID",
  "INFISICAL_APP_CLIENT_SECRET",
  "INFISICAL_CT_CLIENT_ID",
  "INFISICAL_CT_CLIENT_SECRET",
  "INFISICAL_TOKEN",
  "INFISICAL_SHARED_TOKEN",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  "INFISICAL_PROJECT_ID",
  "INFISICAL_ENV",
  "INFISICAL_PATH",
  "INFISICAL_WATCH",
  "INFISICAL_SHARED_PROJECT_ID",
  "INFISICAL_SHARED_ENV",
  "INFISICAL_SHARED_PATH",
  "INFISICAL_DOMAIN",
  "INFISICAL_API_URL",
  "INFISICAL_BASE_URL",
  "GLOBAL_API_KEYS_FILE",
] as const;

function tempRoot() {
  const path = mkdtempSync(join(tmpdir(), "socratic-infisical-bootstrap-"));
  tempRoots.push(path);
  return path;
}

function isolatedProcessEnv(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("INFISICAL") || key.startsWith("INFIISICAL")) delete env[key];
  }
  delete env.GLOBAL_API_KEYS_FILE;
  Object.assign(env, extra);
  return env;
}

function nextEnvironmentReloadProbe(root: string, extra: Record<string, string> = {}) {
  return `const nextEnv = require(${JSON.stringify(nextEnvEntry)});
nextEnv.loadEnvConfig(${JSON.stringify(root)}, false, { info() {}, error() {} }, true);
const maskKeys = ${JSON.stringify(EXPECTED_FINAL_MASK_KEYS)};
console.log("FINAL_ENV=" + JSON.stringify({
  nonEmptyBootstrap: maskKeys.filter((key) => Boolean(process.env[key])),
  globalOverride: process.env.GLOBAL_API_KEYS_FILE || "",
  source: process.env.SECRETS_SOURCE,
  ${Object.entries(extra).map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(",\n  ")}
}));`;
}

function finalEnvironment(stdout: string) {
  const line = stdout.split("\n").find((item) => item.startsWith("FINAL_ENV="));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("FINAL_ENV=".length));
}

async function waitForFile(path: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for test marker: ${path}`);
}

afterEach(() => {
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Infisical bootstrap resolver", () => {
  it("keeps the final mask contract complete and independently enumerated", () => {
    expect([...INFISICAL_FINAL_APP_MASK_KEYS].sort()).toEqual([...EXPECTED_FINAL_MASK_KEYS].sort());
  });

  it("maps the owner-provided INFIISICAL_ST and CT_SHARED aliases with safe project defaults", () => {
    const result = resolveInfisicalBootstrap({
      globalEnv: {
        INFIISICAL_ST_CLIENT_ID: "st-id",
        INFIISICAL_ST_CLIENT_SECRET: "st-secret",
        INFISICAL_CT_SHARED_CLIENT_ID: "shared-id",
        INFISICAL_CT_SHARED_CLIENT_SECRET: "shared-secret",
      },
    });

    expect(result.updates).toMatchObject({
      INFISICAL_CLIENT_ID: "st-id",
      INFISICAL_CLIENT_SECRET: "st-secret",
      INFISICAL_PROJECT_ID: DEFAULT_APP_PROJECT_ID,
      INFISICAL_SHARED_CLIENT_ID: "shared-id",
      INFISICAL_SHARED_CLIENT_SECRET: "shared-secret",
      INFISICAL_SHARED_PROJECT_ID: DEFAULT_SHARED_PROJECT_ID,
    });
  });

  it("accepts the corrected global ST spelling and generic shared names in local scopes", () => {
    const result = resolveInfisicalBootstrap({
      globalEnv: {
        INFISICAL_ST_CLIENT_ID: "corrected-id",
        INFISICAL_ST_CLIENT_SECRET: "corrected-secret",
      },
      localEnv: {
        INFISICAL_SHARED_CLIENT_ID: "generic-shared-id",
        INFISICAL_SHARED_CLIENT_SECRET: "generic-shared-secret",
      },
    });

    expect(result.updates.INFISICAL_CLIENT_ID).toBe("corrected-id");
    expect(result.updates.INFISICAL_SHARED_CLIENT_ID).toBe("generic-shared-id");
  });

  it("preserves process-environment precedence over .env.local and the global file", () => {
    const result = resolveInfisicalBootstrap({
      explicitEnv: {
        INFISICAL_CLIENT_ID: "explicit-id",
        INFISICAL_CLIENT_SECRET: "explicit-secret",
        INFISICAL_PROJECT_ID: "explicit-project",
      },
      localEnv: {
        INFISICAL_CLIENT_ID: "local-id",
        INFISICAL_CLIENT_SECRET: "local-secret",
        INFISICAL_PROJECT_ID: "local-project",
      },
      globalEnv: {
        INFIISICAL_ST_CLIENT_ID: "global-id",
        INFIISICAL_ST_CLIENT_SECRET: "global-secret",
      },
    });

    expect(result.updates.INFISICAL_CLIENT_ID).toBe("explicit-id");
    expect(result.updates.INFISICAL_CLIENT_SECRET).toBe("explicit-secret");
    expect(result.appProjectId).toBe("explicit-project");
  });

  it("lets explicit app/shared aliases beat generic pairs from lower layers", () => {
    const result = resolveInfisicalBootstrap({
      explicitEnv: {
        INFISICAL_ST_CLIENT_ID: "explicit-alias-app-id",
        INFISICAL_ST_CLIENT_SECRET: "explicit-alias-app-secret",
        INFISICAL_CT_SHARED_CLIENT_ID: "explicit-alias-shared-id",
        INFISICAL_CT_SHARED_CLIENT_SECRET: "explicit-alias-shared-secret",
      },
      localEnv: {
        INFISICAL_CLIENT_ID: "local-generic-app-id",
        INFISICAL_CLIENT_SECRET: "local-generic-app-secret",
        INFISICAL_SHARED_CLIENT_ID: "local-generic-shared-id",
        INFISICAL_SHARED_CLIENT_SECRET: "local-generic-shared-secret",
      },
    });

    expect(result.updates.INFISICAL_CLIENT_ID).toBe("explicit-alias-app-id");
    expect(result.updates.INFISICAL_SHARED_CLIENT_ID).toBe("explicit-alias-shared-id");
  });

  it("lets an explicit token beat lower-precedence machine-identity pairs", () => {
    const result = resolveInfisicalBootstrap({
      explicitEnv: { INFISICAL_TOKEN: "explicit-token" },
      localEnv: {
        INFISICAL_CLIENT_ID: "local-id",
        INFISICAL_CLIENT_SECRET: "local-secret",
      },
    });

    expect(result.updates.INFISICAL_TOKEN).toBe("explicit-token");
    expect(result.updates.INFISICAL_CLIENT_ID).toBeUndefined();
  });

  it("prefers complete app and shared alias pairs over stale tokens in the same layer", () => {
    const result = resolveInfisicalBootstrap({
      explicitEnv: {
        INFIISICAL_ST_CLIENT_ID: "app-pair-id",
        INFIISICAL_ST_CLIENT_SECRET: "app-pair-secret",
        INFISICAL_TOKEN: "stale-app-token",
        INFISICAL_CT_SHARED_CLIENT_ID: "shared-pair-id",
        INFISICAL_CT_SHARED_CLIENT_SECRET: "shared-pair-secret",
        INFISICAL_SHARED_TOKEN: "stale-shared-token",
      },
    });

    expect(result.updates).toMatchObject({
      INFISICAL_CLIENT_ID: "app-pair-id",
      INFISICAL_CLIENT_SECRET: "app-pair-secret",
      INFISICAL_SHARED_CLIENT_ID: "shared-pair-id",
      INFISICAL_SHARED_CLIENT_SECRET: "shared-pair-secret",
    });
    expect(result.updates.INFISICAL_TOKEN).toBeUndefined();
    expect(result.updates.INFISICAL_SHARED_TOKEN).toBeUndefined();
  });

  it("rejects conflicting complete aliases in one precedence layer", () => {
    expect(() => resolveInfisicalBootstrap({
      explicitEnv: {
        INFISICAL_CLIENT_ID: "generic-id",
        INFISICAL_CLIENT_SECRET: "generic-secret-never-print",
        INFISICAL_ST_CLIENT_ID: "scoped-id",
        INFISICAL_ST_CLIENT_SECRET: "scoped-secret-never-print",
      },
    })).toThrow("Conflicting complete app credential aliases");
  });

  it("narrows the global file to ST app and CT-shared aliases", () => {
    const result = resolveInfisicalBootstrap({
      globalEnv: {
        INFISICAL_CLIENT_ID: "wrong-generic-app-id",
        INFISICAL_CLIENT_SECRET: "wrong-generic-app-secret",
        INFISICAL_TOKEN: "wrong-global-token",
        INFISICAL_ENV: "wrong-global-environment",
        INFISICAL_ST_CLIENT_ID: "scoped-app-id",
        INFISICAL_ST_CLIENT_SECRET: "scoped-app-secret",
        INFISICAL_SHARED_CLIENT_ID: "generic-shared-id",
        INFISICAL_SHARED_CLIENT_SECRET: "generic-shared-secret",
        INFISICAL_CT_SHARED_CLIENT_ID: "scoped-shared-id",
        INFISICAL_CT_SHARED_CLIENT_SECRET: "scoped-shared-secret",
      },
    });

    expect(result.updates.INFISICAL_CLIENT_ID).toBe("scoped-app-id");
    expect(result.updates.INFISICAL_SHARED_CLIENT_ID).toBe("scoped-shared-id");
    expect(result.updates.INFISICAL_TOKEN).toBeUndefined();
    expect(result.updates.INFISICAL_ENV).toBeUndefined();

    const genericSharedOnly = resolveInfisicalBootstrap({
      globalEnv: {
        INFISICAL_ST_CLIENT_ID: "scoped-app-id",
        INFISICAL_ST_CLIENT_SECRET: "scoped-app-secret",
        INFISICAL_SHARED_CLIENT_ID: "must-not-cross-global-boundary",
        INFISICAL_SHARED_CLIENT_SECRET: "must-not-cross-global-boundary",
      },
    });
    expect(genericSharedOnly.sharedAuthConfigured).toBe(false);
    expect(genericSharedOnly.sharedProjectId).toBeUndefined();
  });

  it("fails closed on a partial alias without printing its supplied value", () => {
    let caught: unknown;
    try {
      resolveInfisicalBootstrap({
        globalEnv: { INFIISICAL_ST_CLIENT_SECRET: "never-echo-this-secret" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InfisicalBootstrapError);
    expect((caught as Error).message).toContain("INFIISICAL_ST_CLIENT_ID");
    expect((caught as Error).message).not.toContain("never-echo-this-secret");
  });

  it("does not combine a partial higher-precedence pair with a lower layer", () => {
    expect(() => resolveInfisicalBootstrap({
      explicitEnv: { INFISICAL_CLIENT_ID: "explicit-id-only" },
      localEnv: { INFISICAL_CLIENT_SECRET: "local-secret-only" },
      globalEnv: {
        INFISICAL_ST_CLIENT_ID: "global-id",
        INFISICAL_ST_CLIENT_SECRET: "global-secret",
      },
    })).toThrow(InfisicalBootstrapError);
  });

  it("does not enable the shared overlay until shared auth or an explicit project is present", () => {
    const appOnly = resolveInfisicalBootstrap({
      globalEnv: {
        INFISICAL_ST_CLIENT_ID: "app-id",
        INFISICAL_ST_CLIENT_SECRET: "app-secret",
      },
    });
    expect(appOnly.sharedProjectId).toBeUndefined();

    const explicitSharedProject = resolveInfisicalBootstrap({
      explicitEnv: {
        INFISICAL_TOKEN: "app-token",
        INFISICAL_SHARED_PROJECT_ID: "operator-project",
      },
    });
    expect(explicitSharedProject.sharedProjectId).toBe("operator-project");
  });

  it("rejects a shared-only overlay before any runner can call Infisical", () => {
    expect(() => resolveInfisicalBootstrap({
      globalEnv: {
        INFISICAL_CT_SHARED_CLIENT_ID: "shared-id",
        INFISICAL_CT_SHARED_CLIENT_SECRET: "shared-secret",
      },
    })).toThrow("Shared overlay requires an explicit app identity/token");
  });

  it("imports only recognized global bootstrap keys and normalizes aliases in process memory", () => {
    const root = tempRoot();
    const globalFile = join(root, "global-api-keys");
    writeFileSync(globalFile, [
      "INFISICAL_ST_CLIENT_ID=global-app-id",
      "INFISICAL_ST_CLIENT_SECRET=global-app-secret",
      "OPENROUTER_API_KEY=must-not-be-loaded",
      "",
    ].join("\n"), { mode: 0o600 });
    const env = isolatedProcessEnv();

    const result = prepareInfisicalBootstrapEnvironment({ env, cwd: root, globalFile });

    expect(result.appAuthConfigured).toBe(true);
    expect(env.INFISICAL_CLIENT_ID).toBe("global-app-id");
    expect(env.INFISICAL_ST_CLIENT_ID).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).not.toBe("must-not-be-loaded");
  });

  it("ignores unrelated shell syntax and malformed assignments in the broad global file", () => {
    const root = tempRoot();
    const globalFile = join(root, "global-api-keys");
    writeFileSync(globalFile, [
      "function unrelated_helper() { echo this-is-not-dotenv; }",
      "UNRELATED_MALFORMED value-without-equals",
      "ANOTHER_PROVIDER_SECRET=$(printf never-execute-this)",
      "INFISICAL_ST_CLIENT_ID=managed-app-id",
      "INFISICAL_ST_CLIENT_SECRET=managed-app-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    const env = isolatedProcessEnv();

    prepareInfisicalBootstrapEnvironment({ env, cwd: root, globalFile });

    expect(env.INFISICAL_CLIENT_ID).toBe("managed-app-id");
    expect(env.INFISICAL_CLIENT_SECRET).toBe("managed-app-secret");
    expect(env.ANOTHER_PROVIDER_SECRET).toBeUndefined();
  });

  it("does not import managed-looking lines inside unrelated quoted or indented data", () => {
    const root = tempRoot();
    const globalFile = join(root, "global-api-keys");
    writeFileSync(globalFile, [
      "UNRELATED_MULTILINE=\"line one",
      "INFISICAL_ST_CLIENT_ID=multiline-data-trap",
      "line three\"",
      "INFISICAL_ST_CLIENT_ID=real-managed-id",
      "INFISICAL_ST_CLIENT_SECRET=real-managed-secret",
      "  INFISICAL_ST_CLIENT_SECRET=indented-shell-trap",
      "",
    ].join("\n"), { mode: 0o600 });
    const env = isolatedProcessEnv();

    prepareInfisicalBootstrapEnvironment({ env, cwd: root, globalFile });

    expect(env.INFISICAL_CLIENT_ID).toBe("real-managed-id");
    expect(env.INFISICAL_CLIENT_SECRET).toBe("real-managed-secret");
  });

  it("fails closed on multiline shell blocks and heredocs instead of parsing nested data", () => {
    for (const [name, lines] of [
      ["nested-shell", [
        "if true; then",
        "if false; then",
        "fi",
        "INFISICAL_ST_CLIENT_ID=nested-shell-trap",
        "fi",
      ]],
      ["hyphen-heredoc", [
        "cat <<'END-DATA'",
        "INFISICAL_ST_CLIENT_SECRET=heredoc-data-trap",
        "END-DATA",
      ]],
    ] as const) {
      const root = tempRoot();
      const globalFile = join(root, name);
      writeFileSync(globalFile, [
        "INFISICAL_ST_CLIENT_ID=real-id",
        "INFISICAL_ST_CLIENT_SECRET=real-secret-never-print",
        ...lines,
        "",
      ].join("\n"), { mode: 0o600 });

      let caught: unknown;
      try {
        prepareInfisicalBootstrapEnvironment({
          env: isolatedProcessEnv(),
          cwd: root,
          globalFile,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InfisicalBootstrapError);
      expect((caught as Error).message).toContain("Could not safely parse");
      expect((caught as Error).message).not.toContain("real-secret-never-print");
    }
  });

  it("rejects NUL-bearing bootstrap data without echoing its value", () => {
    let caught: unknown;
    try {
      resolveInfisicalBootstrap({
        localEnv: {
          INFISICAL_CLIENT_ID: "nul-id",
          INFISICAL_CLIENT_SECRET: "prefix\0secret-never-print",
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InfisicalBootstrapError);
    expect((caught as Error).message).toContain("Invalid NUL byte");
    expect((caught as Error).message).not.toContain("secret-never-print");
  });

  it("rejects a live or broken global-file symlink without reading its target", () => {
    const root = tempRoot();
    const realFile = join(root, "real-global-api-keys");
    writeFileSync(realFile, [
      "INFISICAL_ST_CLIENT_ID=target-id",
      "INFISICAL_ST_CLIENT_SECRET=target-secret-never-read",
      "",
    ].join("\n"), { mode: 0o600 });

    for (const [name, target] of [
      ["live-link", realFile],
      ["broken-link", join(root, "missing-target")],
    ] as const) {
      const link = join(root, name);
      symlinkSync(target, link);
      let caught: unknown;
      try {
        prepareInfisicalBootstrapEnvironment({ env: isolatedProcessEnv(), cwd: root, globalFile: link });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InfisicalBootstrapError);
      expect((caught as Error).message).toContain("regular, non-symlink file");
      expect((caught as Error).message).not.toContain("target-secret-never-read");
    }
  });

  it("rejects a non-regular global-file path", () => {
    const root = tempRoot();
    const directoryPath = join(root, "global-api-keys-directory");
    mkdirSync(directoryPath);

    expect(() => prepareInfisicalBootstrapEnvironment({
      env: isolatedProcessEnv(),
      cwd: root,
      globalFile: directoryPath,
    })).toThrow("regular, non-symlink file");
  });

  it("rejects group/other-readable or writable global-file modes without exposing values", () => {
    for (const mode of [0o640, 0o602]) {
      const root = tempRoot();
      const globalFile = join(root, `global-api-keys-${mode.toString(8)}`);
      writeFileSync(globalFile, [
        "INFISICAL_ST_CLIENT_ID=mode-id",
        "INFISICAL_ST_CLIENT_SECRET=mode-secret-never-print",
        "",
      ].join("\n"), { mode: 0o600 });
      chmodSync(globalFile, mode);

      let caught: unknown;
      try {
        prepareInfisicalBootstrapEnvironment({ env: isolatedProcessEnv(), cwd: root, globalFile });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InfisicalBootstrapError);
      expect((caught as Error).message).toContain("must not grant group/other permissions");
      expect((caught as Error).message).not.toContain("mode-secret-never-print");
    }
  });

  it("rejects duplicate managed assignments instead of silently changing identity", () => {
    const root = tempRoot();
    const globalFile = join(root, "global-api-keys");
    writeFileSync(globalFile, [
      "INFISICAL_ST_CLIENT_ID=first-id",
      "INFISICAL_ST_CLIENT_ID=second-id",
      "INFISICAL_ST_CLIENT_SECRET=secret-never-print",
      "",
    ].join("\n"), { mode: 0o600 });

    let caught: unknown;
    try {
      prepareInfisicalBootstrapEnvironment({
        env: isolatedProcessEnv(),
        cwd: root,
        globalFile,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InfisicalBootstrapError);
    expect((caught as Error).message).toContain("Could not safely parse");
    expect((caught as Error).message).not.toContain("secret-never-print");
  });

  it("parses shell-looking global values as inert dotenv data", () => {
    const root = tempRoot();
    const marker = join(root, "shell-expression-ran");
    const shellLooking = `$(touch ${marker})`;
    const globalFile = join(root, "global-api-keys");
    writeFileSync(globalFile, [
      "INFISICAL_ST_CLIENT_ID=shell-test-id",
      `INFISICAL_ST_CLIENT_SECRET=${JSON.stringify(shellLooking)}`,
      "",
    ].join("\n"), { mode: 0o600 });
    const env = isolatedProcessEnv();

    prepareInfisicalBootstrapEnvironment({ env, cwd: root, globalFile });

    expect(env.INFISICAL_CLIENT_SECRET).toBe(shellLooking);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("infisical-run bootstrap integration", () => {
  it("preserves command argv with spaces and embedded separators at the final wrapper", () => {
    const probe = `console.log("ARGV_RESULT=" + JSON.stringify({
      argv: process.argv.slice(1),
      token: process.env.INFISICAL_TOKEN || "",
      project: process.env.INFISICAL_PROJECT_ID || "",
    }));`;
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/infisical-app-child.mjs"),
        "--",
        process.execPath,
        "-e",
        probe,
        "argument with spaces",
        "--",
        "tail=value",
      ],
      {
        encoding: "utf8",
        env: isolatedProcessEnv({
          INFISICAL_TOKEN: "wrapper-token-must-be-masked",
          INFISICAL_PROJECT_ID: "wrapper-project-must-be-masked",
        }),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((item) => item.startsWith("ARGV_RESULT="));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice("ARGV_RESULT=".length))).toEqual({
      argv: ["argument with spaces", "--", "tail=value"],
      token: "",
      project: "",
    });
  });

  it.each([
    ["INFISICAL_ENV", "dev"],
    ["INFISICAL_ENV", "staging"],
    ["INFISICAL_SHARED_ENV", "dev"],
    ["INFISICAL_SHARED_ENV", "staging"],
  ])("refuses a non-prod %s=%s before invoking the Infisical executable", (key, value) => {
    // prod is the only Infisical environment (owner 2026-10-10: dev and staging retired).
    const root = tempRoot();
    const bin = join(root, "bin");
    const marker = join(root, "infisical-was-called");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "called");
process.exit(0);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
          [key]: value,
        }),
      }
    );

    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).toContain(`${key} must be "prod"`);
  });

  it("fails a shared-only overlay before invoking the Infisical executable", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const marker = join(root, "infisical-was-called");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "called");
process.exit(0);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
          INFISICAL_CT_SHARED_CLIENT_ID: "shared-only-id",
          INFISICAL_CT_SHARED_CLIENT_SECRET: "shared-only-secret-never-print",
        }),
      }
    );

    expect(result.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).toContain("Shared overlay requires an explicit app identity/token");
    expect(result.stderr).not.toContain("shared-only-secret-never-print");
  });

  it("loads .env.local before auth, defaults both project IDs, and never prints or passes long-lived secrets", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    const probeLeakMarker = join(root, "probe-received-bootstrap-credential");
    const bootstrapCredentialKeys = [...INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS];
    const finalMaskKeys = [...EXPECTED_FINAL_MASK_KEYS];
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, ".env.local"), [
      "INFIISICAL_ST_CLIENT_ID=local-app-id",
      "INFIISICAL_ST_CLIENT_SECRET=local-app-secret-never-print",
      "INFISICAL_CT_SHARED_CLIENT_ID=local-shared-id",
      "INFISICAL_CT_SHARED_CLIENT_SECRET=local-shared-secret-never-print",
      "",
    ].join("\n"));
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const bootstrapCredentialKeys = ${JSON.stringify(bootstrapCredentialKeys)};
const finalMaskKeys = ${JSON.stringify(finalMaskKeys)};
if (args[0] === "--version") {
  const leaked = bootstrapCredentialKeys.filter((key) => Boolean(process.env[key]));
  if (leaked.length > 0) writeFileSync(${JSON.stringify(probeLeakMarker)}, leaked.join(","));
  console.log("fake-infisical");
  process.exit(0);
}
if (args[0] === "login") { console.log("short-lived-test-token"); process.exit(0); }
if (args[0] === "export") {
  const projectIndex = args.indexOf("--projectId");
  const output = [{ key: "REMOTE_PROJECT", value: args[projectIndex + 1] }];
  for (const key of finalMaskKeys) {
    output.push({ key, value: "exported-bootstrap-must-not-reach-child" });
  }
  console.log(JSON.stringify(output));
  process.exit(0);
}
if (args[0] === "run") {
  const separator = args.indexOf("--");
  const child = spawnSync(args[separator + 1], args.slice(separator + 2), {
    env: process.env,
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const childProbe = `const nonEmptyBootstrap = ${JSON.stringify(finalMaskKeys)}.filter((key) => Boolean(process.env[key]));
      console.log("BOOTSTRAP_RESULT=" + JSON.stringify({
        source: process.env.SECRETS_SOURCE,
        appProject: process.env.INFISICAL_PROJECT_ID || "",
        sharedProject: process.env.INFISICAL_SHARED_PROJECT_ID || "",
        remoteProject: process.env.REMOTE_PROJECT,
        nonEmptyBootstrap,
      }));`;
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", childProbe],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
        }),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("local-app-secret-never-print");
    expect(result.stdout).not.toContain("local-shared-secret-never-print");
    expect(result.stderr).not.toContain("local-app-secret-never-print");
    expect(result.stderr).not.toContain("local-shared-secret-never-print");
    expect(existsSync(probeLeakMarker)).toBe(false);
    const line = result.stdout.split("\n").find((item) => item.startsWith("BOOTSTRAP_RESULT="));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice("BOOTSTRAP_RESULT=".length))).toEqual({
      source: "infisical",
      appProject: "",
      sharedProject: "",
      remoteProject: DEFAULT_APP_PROJECT_ID,
      nonEmptyBootstrap: [],
    });
  });

  it("keeps ambient provider/cross-app secrets out of CLI helpers and masks dotenv/remote bootstrap values", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    const cliLeakMarker = join(root, "cli-received-unrelated-secret");
    const pairMarker = join(root, "machine-pair-was-used");
    const domainMarker = join(root, "cli-received-domain");
    const roundTripValue = "line one\nline \"two\" \\ tail=${LITERAL}";
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, ".env.local"), [
      "INFIISICAL_ST_CLIENT_ID=local-app-id",
      "INFIISICAL_ST_CLIENT_SECRET=local-app-secret-never-print",
      "INFISICAL_TOKEN=stale-token-must-lose",
      "INFISICAL_DOMAIN=https://eu.example.invalid/api",
      "",
    ].join("\n"));
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const forbidden = [
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
  "SLACK_BOT_TOKEN",
  "ALPACA_API_KEY",
  "NODE_OPTIONS",
  "INFISICAL_CT_CLIENT_SECRET",
  "INFISICAL_CLIENT_SECRET",
  "INFIISICAL_ST_CLIENT_SECRET",
  "GLOBAL_API_KEYS_FILE",
];
const leaked = forbidden.filter((key) => Boolean(process.env[key]));
if (leaked.length > 0) writeFileSync(${JSON.stringify(cliLeakMarker)}, leaked.join(","));
if (process.env.INFISICAL_DOMAIN === "https://eu.example.invalid/api") {
  writeFileSync(${JSON.stringify(domainMarker)}, "domain");
}
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") {
  if (process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID === "local-app-id") {
    writeFileSync(${JSON.stringify(pairMarker)}, "pair");
  }
  console.log("short-lived-login-token");
  process.exit(0);
}
if (args[0] === "export") {
  console.log(JSON.stringify([
    { key: "REMOTE_VALUE", value: "remote-ok", workspace: "test", type: "shared", tags: [] },
    { key: "ROUND_TRIP_VALUE", value: ${JSON.stringify(roundTripValue)} },
    { key: "INFISICAL_TOKEN", value: "remote-token-must-not-reach-app" },
    { key: "INFISICAL_CLIENT_SECRET", value: "remote-client-secret-must-not-reach-app" },
    { key: "INFISICAL_CT_CLIENT_SECRET", value: "remote-cross-app-secret-must-not-reach-app" },
    { key: "INFISICAL_ENV", value: "remote-runtime-must-not-reach-app" },
  ]));
  process.exit(0);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/infisical-run.mjs"),
        "--",
        process.execPath,
        "-e",
        nextEnvironmentReloadProbe(root, {
          provider: "process.env.OPENROUTER_API_KEY || ''",
          remoteValue: "process.env.REMOTE_VALUE || ''",
          roundTripValue: "process.env.ROUND_TRIP_VALUE || ''",
          crossApp: "process.env.INFISICAL_CT_CLIENT_SECRET || ''",
        }),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          HOME: root,
          PATH: `${bin}:${process.env.PATH || ""}`,
          OPENROUTER_API_KEY: "ambient-provider-key",
          GITHUB_TOKEN: "ambient-github-token",
          SLACK_BOT_TOKEN: "ambient-slack-token",
          ALPACA_API_KEY: "ambient-broker-token",
          INFISICAL_CT_CLIENT_SECRET: "ambient-cross-app-secret",
          GLOBAL_API_KEYS_FILE: join(root, "ignored-ambient-override"),
        }),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cliLeakMarker)).toBe(false);
    expect(existsSync(pairMarker)).toBe(true);
    expect(existsSync(domainMarker)).toBe(true);
    expect(result.stdout).not.toContain("local-app-secret-never-print");
    expect(result.stdout).not.toContain("stale-token-must-lose");
    const final = finalEnvironment(result.stdout);
    expect(final).toEqual({
      nonEmptyBootstrap: [],
      globalOverride: "",
      source: "infisical",
      provider: "ambient-provider-key",
      remoteValue: "remote-ok",
      roundTripValue,
      crossApp: "",
    });
  });

  it("ignores the former ambient global-file override outside dependency-injected unit tests", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    const overrideFile = join(root, "ambient-override");
    const loginMarker = join(root, "unexpected-login");
    mkdirSync(bin, { recursive: true });
    writeFileSync(overrideFile, [
      "INFIISICAL_ST_CLIENT_ID=override-id",
      "INFIISICAL_ST_CLIENT_SECRET=override-secret-never-use",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") {
  writeFileSync(${JSON.stringify(loginMarker)}, "called");
  process.exit(17);
}
if (args[0] === "export") {
  console.log(JSON.stringify([{ key: "REMOTE_VALUE", value: "stored-session-export" }]));
  process.exit(0);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/infisical-run.mjs"),
        "--",
        process.execPath,
        "-e",
        nextEnvironmentReloadProbe(root, {
          remoteValue: "process.env.REMOTE_VALUE || ''",
        }),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          HOME: root,
          PATH: `${bin}:${process.env.PATH || ""}`,
          GLOBAL_API_KEYS_FILE: overrideFile,
        }),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(loginMarker)).toBe(false);
    expect(result.stdout).not.toContain("override-secret-never-use");
    expect(finalEnvironment(result.stdout)).toEqual({
      nonEmptyBootstrap: [],
      globalOverride: "",
      source: "infisical",
      remoteValue: "stored-session-export",
    });
  });

  it("masks credentials injected by Infisical watch before Next reloads dotenv", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    const cliLeakMarker = join(root, "watch-cli-received-provider-secret");
    const ambientPreload = join(root, "ambient-preload.cjs");
    const ambientPreloadObservations = join(root, "ambient-preload-observations");
    const remotePreload = join(root, "remote-preload.cjs");
    const remotePreloadMarker = join(root, "remote-preload-ran");
    mkdirSync(bin, { recursive: true });
    writeFileSync(ambientPreload, `const { appendFileSync } = require("node:fs");
const keys = ${JSON.stringify(EXPECTED_FINAL_MASK_KEYS)};
appendFileSync(${JSON.stringify(ambientPreloadObservations)}, JSON.stringify({
  nonEmptyBootstrap: keys.filter((key) => Boolean(process.env[key])),
  source: process.env.SECRETS_SOURCE || "",
}) + "\\n");
`);
    writeFileSync(remotePreload, `require("node:fs").writeFileSync(${JSON.stringify(remotePreloadMarker)}, "ran");\n`);
    writeFileSync(join(root, ".env.local"), [
      "INFIISICAL_ST_CLIENT_ID=watch-app-id",
      "INFIISICAL_ST_CLIENT_SECRET=watch-app-secret-never-print",
      "INFISICAL_WATCH=true",
      "",
    ].join("\n"));
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.OPENROUTER_API_KEY || process.env.NODE_OPTIONS || process.env.INFISICAL_CLIENT_SECRET || process.env.INFIISICAL_ST_CLIENT_SECRET) {
  writeFileSync(${JSON.stringify(cliLeakMarker)}, "leaked");
}
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") {
  console.log("watch-short-token");
  process.exit(0);
}
if (args[0] === "run") {
  const separator = args.indexOf("--");
  const child = spawnSync(args[separator + 1], args.slice(separator + 2), {
    env: {
      ...process.env,
      INFISICAL_TOKEN: "watch-injected-token",
      INFISICAL_CLIENT_SECRET: "watch-injected-client-secret",
      INFIISICAL_ST_CLIENT_SECRET: "watch-injected-alias-secret",
      GLOBAL_API_KEYS_FILE: "watch-injected-override",
      NODE_OPTIONS: ${JSON.stringify(`--require=${remotePreload}`)},
    },
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/infisical-run.mjs"),
        "--",
        process.execPath,
        "-e",
        nextEnvironmentReloadProbe(root),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          HOME: root,
          PATH: `${bin}:${process.env.PATH || ""}`,
          OPENROUTER_API_KEY: "ambient-provider-must-not-reach-watch-cli",
          NODE_OPTIONS: `--require=${ambientPreload}`,
        }),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cliLeakMarker)).toBe(false);
    expect(existsSync(remotePreloadMarker)).toBe(false);
    expect(result.stdout).not.toContain("watch-app-secret-never-print");
    expect(finalEnvironment(result.stdout)).toEqual({
      nonEmptyBootstrap: [],
      globalOverride: "",
      source: "infisical",
    });
    const preloadLines = readFileSync(ambientPreloadObservations, "utf8").trim().split("\n");
    expect(preloadLines.length).toBeGreaterThanOrEqual(1);
    const preloadObservations = preloadLines.map((line) => JSON.parse(line));
    expect(preloadObservations.every((observation) => observation.nonEmptyBootstrap.length === 0)).toBe(true);
    expect(preloadObservations).toContainEqual({ nonEmptyBootstrap: [], source: "infisical" });
  });

  it("suppresses login stderr that echoes long-lived credentials", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") {
  console.error(process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID || "");
  console.error(process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || "");
  process.exit(23);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
          INFISICAL_CLIENT_ID: "login-app-id-never-print",
          INFISICAL_CLIENT_SECRET: "login-app-secret-never-print",
        }),
      }
    );

    expect(result.status).toBe(23);
    expect(result.stderr).toContain("CLI output was suppressed");
    expect(result.stderr).not.toContain("login-app-id-never-print");
    expect(result.stderr).not.toContain("login-app-secret-never-print");
  });

  it("suppresses export stderr that echoes short-lived tokens", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") {
  const id = process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID || "";
  console.log(id.startsWith("shared-") ? "shared-short-token-never-print" : "app-short-token-never-print");
  process.exit(0);
}
if (args[0] === "export") {
  console.error(process.env.INFISICAL_TOKEN || "");
  process.exit(29);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
          INFISICAL_CLIENT_ID: "app-export-id",
          INFISICAL_CLIENT_SECRET: "app-export-secret-never-print",
          INFISICAL_SHARED_CLIENT_ID: "shared-export-id",
          INFISICAL_SHARED_CLIENT_SECRET: "shared-export-secret-never-print",
        }),
      }
    );

    expect(result.status).toBe(29);
    expect(result.stderr).toContain("CLI output was suppressed");
    expect(result.stderr).not.toContain("app-short-token-never-print");
    expect(result.stderr).not.toContain("shared-short-token-never-print");
    expect(result.stderr).not.toContain("app-export-secret-never-print");
    expect(result.stderr).not.toContain("shared-export-secret-never-print");
  });

  it("rejects NUL-bearing JSON exports without echoing the secret", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "export") {
  console.log(JSON.stringify([{ key: "BAD_VALUE", value: ${JSON.stringify("prefix\0secret-never-print")} }]));
  process.exit(0);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
        }),
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("returned invalid JSON");
    expect(result.stdout).not.toContain("secret-never-print");
    expect(result.stderr).not.toContain("secret-never-print");
  });

  it.each([
    ["flat key/value objects", JSON.stringify({ SAFE_KEY: "value" })],
    [
      "duplicate secret keys",
      JSON.stringify([
        { key: "DUPLICATE_KEY", value: "first" },
        { key: "DUPLICATE_KEY", value: "second" },
      ]),
    ],
    ["records without string values", JSON.stringify([{ key: "MISSING_VALUE" }])],
    ["records without non-empty keys", JSON.stringify([{ key: "", value: "value" }])],
  ])("rejects %s from the pinned CLI JSON boundary", (_label, payload) => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "export") {
  console.log(${JSON.stringify(payload)});
  process.exit(0);
}
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, "-e", "process.exit(0)"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
        }),
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("returned invalid JSON");
    expect(result.stdout).toBe("");
  });

  it("forwards termination through the runner and final wrapper", async () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    const fakeInfisical = join(bin, "infisical");
    const finalChild = join(root, "signal-child.mjs");
    const readyMarker = join(root, "signal-child-ready");
    const terminatedMarker = join(root, "signal-child-terminated");
    mkdirSync(bin, { recursive: true });
    writeFileSync(fakeInfisical, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "login") { console.log("test-token"); process.exit(0); }
if (args[0] === "export") { console.log("[]"); process.exit(0); }
process.exit(3);
`);
    chmodSync(fakeInfisical, 0o755);
    writeFileSync(finalChild, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyMarker)}, "ready");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(terminatedMarker)}, "terminated");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`);

    const child = spawn(
      process.execPath,
      [resolve(repoRoot, "scripts/infisical-run.mjs"), "--", process.execPath, finalChild],
      {
        cwd: root,
        env: isolatedProcessEnv({
          PATH: `${bin}:${process.env.PATH || ""}`,
          HOME: root,
          INFISICAL_CLIENT_ID: "signal-test-client-id",
          INFISICAL_CLIENT_SECRET: "signal-test-client-secret",
          INFISICAL_PROJECT_ID: "signal-test-project",
          GLOBAL_API_KEYS_FILE: join(root, "missing-global-api-keys"),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.on("exit", (code, signal) => resolvePromise({ code, signal }));
    });

    try {
      await waitForFile(readyMarker, 20_000);
      expect(child.kill("SIGTERM")).toBe(true);
      const outcome = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runner did not exit")), 10_000)),
      ]);
      // Under runner load the wrapper sometimes dies with SIGTERM before converting to exit 0.
      // Either clean exit 0 or signal-terminated is proof SIGTERM reached the process tree.
      expect(
        (outcome.code === 0 && outcome.signal === null) ||
          (outcome.code === null && outcome.signal === "SIGTERM"),
        stderr
      ).toBe(true);
      await waitForFile(terminatedMarker, 10_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 35_000);
});
