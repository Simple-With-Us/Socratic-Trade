#!/usr/bin/env node

// Resolve only the Infisical bootstrap identity needed by infisical-run.mjs.
// Provider/API secrets remain in Infisical. Resolution order is process
// environment, then .env.local runner controls, then (macOS only) the login
// Keychain: generic passwords with service "socratic-trade-bootstrap" and the
// env var name as the account. The flat ~/.secrets/global-api-keys file is
// retired and is never read (owner, 2026-10-18, OPS-818). Values are never
// logged and are not copied into .env.local.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const DEFAULT_APP_PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
export const DEFAULT_SHARED_PROJECT_ID = "18f563a3-9c88-454c-96eb-28fc9678f3ba";
export const KEYCHAIN_SERVICE = "socratic-trade-bootstrap";
const SECURITY_BIN = "/usr/bin/security";
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 10_000;

const APP_PAIR_KEYS = [
  ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"],
  // The owner's existing alias spelling has an intentional extra I.
  ["INFIISICAL_ST_CLIENT_ID", "INFIISICAL_ST_CLIENT_SECRET"],
  // Also accept the corrected spelling for forward compatibility.
  ["INFISICAL_ST_CLIENT_ID", "INFISICAL_ST_CLIENT_SECRET"],
];

const SHARED_PAIR_KEYS = [
  ["INFISICAL_SHARED_CLIENT_ID", "INFISICAL_SHARED_CLIENT_SECRET"],
  ["INFISICAL_CT_SHARED_CLIENT_ID", "INFISICAL_CT_SHARED_CLIENT_SECRET"],
];

// The Keychain service holds only the app-scoped Socratic aliases and the
// documented CT-shared aliases. Generic app credentials, access tokens, project
// selectors, and environment controls remain valid in process env / .env.local,
// but never come from the Keychain.
const KEYCHAIN_APP_PAIR_KEYS = [
  ["INFIISICAL_ST_CLIENT_ID", "INFIISICAL_ST_CLIENT_SECRET"],
  ["INFISICAL_ST_CLIENT_ID", "INFISICAL_ST_CLIENT_SECRET"],
];

const KEYCHAIN_SHARED_PAIR_KEYS = [
  ["INFISICAL_CT_SHARED_CLIENT_ID", "INFISICAL_CT_SHARED_CLIENT_SECRET"],
];

export const INFISICAL_BOOTSTRAP_RUNTIME_KEYS = Object.freeze([
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
]);

export const INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS = Object.freeze([
  ...new Set([
    ...APP_PAIR_KEYS.flat(),
    ...SHARED_PAIR_KEYS.flat(),
    ...KEYCHAIN_APP_PAIR_KEYS.flat(),
    ...KEYCHAIN_SHARED_PAIR_KEYS.flat(),
    // Other app-scoped names are not resolvable for Socratic-Trade, but must
    // still be scrubbed before any CLI or final app process is launched.
    "INFISICAL_APP_CLIENT_ID",
    "INFISICAL_APP_CLIENT_SECRET",
    "INFISICAL_CT_CLIENT_ID",
    "INFISICAL_CT_CLIENT_SECRET",
    "INFISICAL_TOKEN",
    "INFISICAL_SHARED_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  ]),
]);

export const KEYCHAIN_BOOTSTRAP_KEYS = Object.freeze([...new Set([
  ...KEYCHAIN_APP_PAIR_KEYS.flat(),
  ...KEYCHAIN_SHARED_PAIR_KEYS.flat(),
])]);

const KEYCHAIN_BOOTSTRAP_KEY_SET = new Set(KEYCHAIN_BOOTSTRAP_KEYS);

const LOCAL_BOOTSTRAP_KEYS = new Set([
  ...APP_PAIR_KEYS.flat(),
  ...SHARED_PAIR_KEYS.flat(),
  "INFISICAL_TOKEN",
  "INFISICAL_SHARED_TOKEN",
  ...INFISICAL_BOOTSTRAP_RUNTIME_KEYS,
]);

export const INFISICAL_FINAL_APP_MASK_KEYS = Object.freeze([
  ...INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS,
  ...INFISICAL_BOOTSTRAP_RUNTIME_KEYS,
  // The former flat-file path override is no longer honored, and masking
  // prevents Next from restoring it from dotenv.
  "GLOBAL_API_KEYS_FILE",
]);

export class InfisicalBootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = "InfisicalBootstrapError";
  }
}

function hasValue(values, key) {
  return typeof values?.[key] === "string" && values[key].length > 0;
}

function readEnvFile(path, label) {
  if (!path) return { found: false, values: {} };
  try {
    // lstat (not existsSync/stat) sees broken symlinks, which must be rejected
    // rather than treated as a missing optional credential file.
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { found: false, values: {} };
    }
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Could not safely inspect ${label}.`
    );
  }

  try {
    return { found: true, values: parseEnv(readFileSync(path, "utf8")) };
  } catch {
    // parseEnv errors can include source text. Do not echo an error that may
    // contain a credential value.
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Could not safely parse ${label} at ${path}.`
    );
  }
}

// One Keychain lookup. Returns the stored value, or undefined when the item is
// absent or the Keychain cannot answer (locked, denied, no `security` binary).
// stdout is captured and returned only to the caller; stderr is discarded so no
// value or diagnostic can leak into logs.
export function readKeychainItem(account, { run = spawnSync } = {}) {
  let result;
  try {
    result = run(
      SECURITY_BIN,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
      }
    );
  } catch {
    return undefined;
  }
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const value = result.stdout.replace(/\r?\n$/, "");
  return value.length > 0 ? value : undefined;
}

// Read the bootstrap aliases from the macOS login Keychain. Skipped quietly on
// other platforms (cloud VMs and CI supply process.env) and when
// SOCRATIC_BOOTSTRAP_KEYCHAIN=off (hermetic tests).
export function readKeychainBootstrap({
  env = process.env,
  platform = process.platform,
  readItem = readKeychainItem,
} = {}) {
  if (platform !== "darwin" || env.SOCRATIC_BOOTSTRAP_KEYCHAIN === "off") {
    return { available: false, values: {} };
  }
  const values = {};
  for (const key of KEYCHAIN_BOOTSTRAP_KEYS) {
    const value = readItem(key);
    if (typeof value === "string" && value.length > 0) values[key] = value;
  }
  return { available: true, values };
}

function inspectPair(values, pair, identity, layerLabel) {
  const [idKey, secretKey] = pair;
  const hasId = hasValue(values, idKey);
  const hasSecret = hasValue(values, secretKey);
  if (hasId !== hasSecret) {
    const keychainFix = layerLabel.startsWith("macOS Keychain")
      ? ` Add the missing item with: security add-generic-password -U -s ${KEYCHAIN_SERVICE} ` +
        `-a ${hasId ? secretKey : idKey} -w`
      : "";
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Partial ${identity} credential pair in ${layerLabel}: ` +
      `set both ${idKey} and ${secretKey}.${keychainFix}`
    );
  }
  return hasId ? { idKey, secretKey } : null;
}

function validateLayerValues(layer) {
  for (const [key, value] of Object.entries(layer.values)) {
    if (typeof value === "string" && value.includes("\0")) {
      throw new InfisicalBootstrapError(
        `[infisical-bootstrap] Invalid NUL byte in ${layer.label}:${key}.`
      );
    }
  }
}

function resolveAuth(layers, { identity, pairs, keychainPairs, tokenKey }) {
  for (const layer of layers) {
    const eligiblePairs = layer.kind === "keychain" ? keychainPairs : pairs;
    // Validate every recognized pair in the selected layer. A stale half-pair
    // must not be silently combined with, or hidden by, another credential.
    const completePairs = eligiblePairs
      .map((pair) => inspectPair(layer.values, pair, identity, layer.label))
      .filter(Boolean);

    if (completePairs.length > 1) {
      const [first, ...rest] = completePairs;
      const conflicts = rest.some((pair) => (
        layer.values[pair.idKey] !== layer.values[first.idKey] ||
        layer.values[pair.secretKey] !== layer.values[first.secretKey]
      ));
      if (conflicts) {
        throw new InfisicalBootstrapError(
          `[infisical-bootstrap] Conflicting complete ${identity} credential aliases in ${layer.label}; ` +
          "keep only one pair."
        );
      }
    }

    // The machine identity is primary and a token is only fallback. Preserve
    // that rule for generic and alias pairs alike within every precedence layer.
    const selectedPair = completePairs[0];
    if (selectedPair) {
      return {
        kind: "pair",
        clientId: layer.values[selectedPair.idKey],
        clientSecret: layer.values[selectedPair.secretKey],
        source: `${layer.label}:${selectedPair.idKey}`,
      };
    }

    if (layer.kind !== "keychain" && hasValue(layer.values, tokenKey)) {
      return {
        kind: "token",
        token: layer.values[tokenKey],
        source: `${layer.label}:${tokenKey}`,
      };
    }
  }
  return null;
}

function firstValue(layers, key) {
  for (const layer of layers) {
    if (hasValue(layer.values, key)) return layer.values[key];
  }
  return undefined;
}

function credentialUpdates(appAuth, sharedAuth) {
  const updates = {};
  if (appAuth?.kind === "pair") {
    updates.INFISICAL_CLIENT_ID = appAuth.clientId;
    updates.INFISICAL_CLIENT_SECRET = appAuth.clientSecret;
  } else if (appAuth?.kind === "token") {
    updates.INFISICAL_TOKEN = appAuth.token;
  }

  if (sharedAuth?.kind === "pair") {
    updates.INFISICAL_SHARED_CLIENT_ID = sharedAuth.clientId;
    updates.INFISICAL_SHARED_CLIENT_SECRET = sharedAuth.clientSecret;
  } else if (sharedAuth?.kind === "token") {
    updates.INFISICAL_SHARED_TOKEN = sharedAuth.token;
  }
  return updates;
}

export function resolveInfisicalBootstrap({
  explicitEnv = {},
  localEnv = {},
  keychainEnv = {},
} = {}) {
  const narrowedKeychainEnv = Object.fromEntries(
    Object.entries(keychainEnv).filter(([key]) => KEYCHAIN_BOOTSTRAP_KEY_SET.has(key))
  );
  const layers = [
    { kind: "process", label: "process environment", values: explicitEnv },
    { kind: "local", label: ".env.local", values: localEnv },
    {
      kind: "keychain",
      label: `macOS Keychain (service ${KEYCHAIN_SERVICE})`,
      values: narrowedKeychainEnv,
    },
  ];
  for (const layer of layers) validateLayerValues(layer);

  const appAuth = resolveAuth(layers, {
    identity: "app",
    pairs: APP_PAIR_KEYS,
    keychainPairs: KEYCHAIN_APP_PAIR_KEYS,
    tokenKey: "INFISICAL_TOKEN",
  });
  const sharedAuth = resolveAuth(layers, {
    identity: "shared",
    pairs: SHARED_PAIR_KEYS,
    keychainPairs: KEYCHAIN_SHARED_PAIR_KEYS,
    tokenKey: "INFISICAL_SHARED_TOKEN",
  });

  const appProjectId = firstValue(layers, "INFISICAL_PROJECT_ID") || DEFAULT_APP_PROJECT_ID;
  const configuredSharedProjectId = firstValue(layers, "INFISICAL_SHARED_PROJECT_ID");
  // Do not enable the overlay merely because its project ID is known. Enable
  // the default only when a shared identity/token is actually available.
  const sharedProjectId = configuredSharedProjectId || (sharedAuth ? DEFAULT_SHARED_PROJECT_ID : undefined);
  if (sharedProjectId && !appAuth) {
    // Overlay mode exports both projects and therefore cannot use the CLI's
    // cached interactive login for the app side. Abort before minting/fetching
    // shared credentials so a half-configured overlay makes no network call.
    throw new InfisicalBootstrapError(
      "[infisical-bootstrap] Shared overlay requires an explicit app identity/token; " +
      "set the complete app credential pair or INFISICAL_TOKEN."
    );
  }

  const updates = {
    ...credentialUpdates(appAuth, sharedAuth),
    INFISICAL_PROJECT_ID: appProjectId,
  };
  if (sharedProjectId) updates.INFISICAL_SHARED_PROJECT_ID = sharedProjectId;
  for (const key of INFISICAL_BOOTSTRAP_RUNTIME_KEYS) {
    if (key === "INFISICAL_PROJECT_ID" || key === "INFISICAL_SHARED_PROJECT_ID") continue;
    const value = firstValue(layers, key);
    if (value !== undefined) updates[key] = value;
  }

  return {
    updates,
    appAuthConfigured: Boolean(appAuth),
    sharedAuthConfigured: Boolean(sharedAuth),
    appAuthSource: appAuth?.source,
    sharedAuthSource: sharedAuth?.source,
    appProjectId,
    sharedProjectId,
  };
}

export function prepareInfisicalBootstrapEnvironment({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  readItem = readKeychainItem,
} = {}) {
  // Snapshot the real process environment before loading .env.local so its
  // values retain strict precedence.
  const explicitEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => LOCAL_BOOTSTRAP_KEYS.has(key))
  );
  const local = readEnvFile(resolve(cwd, ".env.local"), ".env.local");
  const keychain = readKeychainBootstrap({ env, platform, readItem });
  const localBootstrapEnv = Object.fromEntries(
    Object.entries(local.values).filter(([key]) => LOCAL_BOOTSTRAP_KEYS.has(key))
  );

  const resolvedBootstrap = resolveInfisicalBootstrap({
    explicitEnv,
    localEnv: localBootstrapEnv,
    keychainEnv: keychain.values,
  });

  // Load only non-secret runner controls from .env.local. Next will load the
  // rest itself after Infisical has injected authoritative app secrets.
  for (const key of INFISICAL_BOOTSTRAP_RUNTIME_KEYS) {
    if (env[key] === undefined && localBootstrapEnv[key] !== undefined) {
      env[key] = localBootstrapEnv[key];
    }
  }

  // Normalize exactly one credential source into the generic names consumed by
  // infisical-run.mjs. Removing aliases here and again in childEnv prevents the
  // app/shared long-lived secrets from leaking into spawned commands.
  for (const key of INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS) delete env[key];
  delete env.GLOBAL_API_KEYS_FILE;
  Object.assign(env, resolvedBootstrap.updates);

  return {
    ...resolvedBootstrap,
    localFileFound: local.found,
    keychainChecked: keychain.available,
    keychainItemCount: Object.keys(keychain.values).length,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  try {
    const result = prepareInfisicalBootstrapEnvironment();
    console.log(
      `[infisical-bootstrap] app identity=${result.appAuthConfigured ? "ready" : "not configured"}; ` +
      `shared identity=${result.sharedAuthConfigured ? "ready" : "not configured"}; ` +
      "credential values were neither printed nor copied."
    );
    if (!result.appAuthConfigured) {
      console.log(
        "[infisical-bootstrap] To store the app identity in the macOS login Keychain, run for each of " +
        `INFISICAL_ST_CLIENT_ID and INFISICAL_ST_CLIENT_SECRET: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a <NAME> -w ` +
        "(enter the value at the prompt). Cloud VMs and CI supply the same names through the process environment."
      );
    }
  } catch (error) {
    const message = error instanceof InfisicalBootstrapError
      ? error.message
      : "[infisical-bootstrap] Bootstrap resolution failed without exposing credential details.";
    console.error(message);
    process.exit(2);
  }
}
