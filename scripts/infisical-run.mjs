#!/usr/bin/env node
// Launch a command with secrets injected from Infisical and propagate its exit.
// Long-lived machine credentials are used only to mint short-lived tokens. No
// bootstrap credential is allowed to reach the final application process.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INFISICAL_FINAL_APP_MASK_KEYS,
  InfisicalBootstrapError,
  prepareInfisicalBootstrapEnvironment,
} from "./infisical-bootstrap-env.mjs";

const separatorIndex = process.argv.indexOf("--");
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);
const finalChildScript = fileURLToPath(new URL("./infisical-app-child.mjs", import.meta.url));
const MAX_EXPORT_OUTPUT_BYTES = 16 * 1024 * 1024;

if (command.length === 0) {
  console.error("Usage: node scripts/infisical-run.mjs -- <command...>");
  process.exit(2);
}

try {
  // Next loads .env.local only after the app starts, which is too late for this
  // runner's authentication. Resolve the narrow bootstrap first.
  prepareInfisicalBootstrapEnvironment();
} catch (error) {
  const message = error instanceof InfisicalBootstrapError
    ? error.message
    : "[infisical-bootstrap] Bootstrap resolution failed without exposing credential details.";
  console.error(message);
  process.exit(2);
}

const appAuth = {
  clientId: process.env.INFISICAL_CLIENT_ID,
  clientSecret: process.env.INFISICAL_CLIENT_SECRET,
  token: process.env.INFISICAL_TOKEN,
};
const sharedAuthOwn = {
  clientId: process.env.INFISICAL_SHARED_CLIENT_ID,
  clientSecret: process.env.INFISICAL_SHARED_CLIENT_SECRET,
  token: process.env.INFISICAL_SHARED_TOKEN,
};

// prod is the only Infisical environment (owner 2026-10-10: dev and staging are
// retired).  Refuse anything else before any CLI call, so a stale INFISICAL_ENV
// or INFISICAL_SHARED_ENV can never read a retired environment.
function requireProdEnvironment(name, value) {
  if (value === "prod") return value;
  console.error(
    `[infisical] ${name} must be "prod" (dev and staging are retired); got "${String(value).slice(0, 32)}". ` +
      "Unset it or set it to prod."
  );
  process.exit(2);
}

// Capture only nonsecret selectors before credential scrubbing.
const envName = requireProdEnvironment("INFISICAL_ENV", process.env.INFISICAL_ENV || "prod");
const secretsPath = process.env.INFISICAL_PATH || "/";
const appProjectId = process.env.INFISICAL_PROJECT_ID;
const sharedProjectId = process.env.INFISICAL_SHARED_PROJECT_ID;
const sharedEnv = requireProdEnvironment("INFISICAL_SHARED_ENV", process.env.INFISICAL_SHARED_ENV || envName);
const sharedPath = process.env.INFISICAL_SHARED_PATH || secretsPath;
const watchEnabled = process.env.INFISICAL_WATCH === "true";
const nodeOptions = process.env.NODE_OPTIONS;
const cliEndpointEnvironment = Object.fromEntries(
  ["INFISICAL_DOMAIN", "INFISICAL_API_URL", "INFISICAL_BASE_URL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);

function scrubBootstrapEnvironment(env) {
  for (const key of INFISICAL_FINAL_APP_MASK_KEYS) delete env[key];
}

// The runner remains alive while the app runs, so remove long-lived credentials
// from its own environment immediately after the one required snapshot.
scrubBootstrapEnvironment(process.env);
const applicationBaseEnv = { ...process.env };

const CLI_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "CI",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

const WATCH_RUNTIME_ALLOWLIST = [
  "NODE_ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "NEXT_TELEMETRY_DISABLED",
  "WATCHPACK_POLLING",
];

function pickEnvironment(source, keys) {
  const selected = {};
  for (const key of keys) {
    if (source[key] !== undefined) selected[key] = source[key];
  }
  return selected;
}

// Probe/login/export receive a strict operating-system allowlist plus the one
// authentication value explicitly supplied by the caller. Provider, GitHub,
// Slack, broker, and cross-app credentials never cross this CLI boundary.
function minimalCliEnvironment(extra = {}) {
  return {
    ...pickEnvironment(applicationBaseEnv, CLI_ENV_ALLOWLIST),
    ...cliEndpointEnvironment,
    INFISICAL_DISABLE_UPDATE_CHECK: "true",
    ...extra,
  };
}

function tokenCliEnvironment(token, extra = {}) {
  return minimalCliEnvironment({
    ...extra,
    ...(token ? { INFISICAL_TOKEN: token } : {}),
  });
}

const probe = spawnSync("infisical", ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: minimalCliEnvironment(),
});
if (probe.error?.code === "ENOENT") {
  console.error("Infisical CLI is not installed or is not on PATH. Install it, then rerun this command.");
  process.exit(127);
}
if (probe.error) {
  console.error("[infisical] Could not invoke the Infisical CLI availability check.");
  process.exit(1);
}
if (probe.status !== 0) {
  console.error(`[infisical] Infisical CLI availability check failed (exit ${probe.status ?? "unknown"}).`);
  process.exit(probe.status || 1);
}

function hasAuth(auth) {
  return Boolean((auth.clientId && auth.clientSecret) || auth.token);
}

function assertCompletePair(auth, label) {
  if (Boolean(auth.clientId) !== Boolean(auth.clientSecret)) {
    const infix = label === "shared" ? "_SHARED" : "";
    console.error(
      `[infisical] Partial ${label} universal-auth credentials: set BOTH ` +
      `INFISICAL${infix}_CLIENT_ID and INFISICAL${infix}_CLIENT_SECRET (or neither).`
    );
    process.exit(2);
  }
}
assertCompletePair(appAuth, "app");
if (sharedProjectId) assertCompletePair(sharedAuthOwn, "shared");

function clearAuth(auth) {
  auth.clientId = undefined;
  auth.clientSecret = undefined;
  auth.token = undefined;
}

function mintToken(clientId, clientSecret, label) {
  const result = spawnSync(
    "infisical",
    ["login", "--method=universal-auth", "--silent", "--plain"],
    {
      encoding: "utf8",
      env: minimalCliEnvironment({
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
      }),
    }
  );
  if (result.error) {
    console.error(`[infisical] Could not invoke 'infisical login' for the ${label} identity.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[infisical] universal-auth login failed for the ${label} identity (exit ${result.status}). ` +
      "Check the Client ID + Client Secret pairing/access. CLI output was suppressed because it may contain credentials."
    );
    process.exit(result.status || 1);
  }
  const token = (result.stdout || "").trim();
  if (!token || token.includes("\0")) {
    console.error(`[infisical] universal-auth login for the ${label} identity returned an empty or invalid token.`);
    process.exit(1);
  }
  return token;
}

function resolveToken(auth, label) {
  try {
    if (auth.clientId && auth.clientSecret) return mintToken(auth.clientId, auth.clientSecret, label);
    if (auth.token) return auth.token;
    return null;
  } finally {
    // Best-effort lifetime minimization: after synchronous mint/copy, the
    // long-lived pair and input token are no longer retained by the runner.
    clearAuth(auth);
  }
}

function buildFinalApplicationEnvironment(extra) {
  const env = { ...applicationBaseEnv, ...extra };
  scrubBootstrapEnvironment(env);
  return env;
}

const SIGNAL_EXIT_CODES = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

function managedChild(child, errorMessage) {
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };
  child.on("error", () => {
    removeSignalHandlers();
    console.error(errorMessage);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) {
      // Never re-raise the signal on ourselves. This runner is container pid 1 in
      // production, and the kernel IGNORES default-disposition signals for pid 1 --
      // the re-raise silently no-ops, the event loop drains, and node exits 0.
      // Docker then records a "clean" exit and production stays down (2026-08-02
      // outage; see docs/rollouts/2026-08-02-exit0-outage-audit.md). Translate to
      // the conventional 128+N so the exit status stays honest at every layer.
      const exitCode = 128 + (SIGNAL_EXIT_CODES[signal] ?? 15);
      console.error(`[infisical] child terminated by ${signal}; exiting ${exitCode}`);
      process.exit(exitCode);
    }
    process.exit(code ?? 1);
  });
}

function finalWrapperArguments(finalNodeOptions) {
  const args = [finalChildScript];
  if (finalNodeOptions !== undefined) {
    args.push("--node-options-base64", Buffer.from(finalNodeOptions, "utf8").toString("base64"));
  }
  args.push("--", ...command);
  return args;
}

function runFinalApplication(env) {
  const finalNodeOptions = env.NODE_OPTIONS;
  delete env.NODE_OPTIONS;
  const child = spawn(
    "/usr/bin/env",
    [
      "-u", "NODE_OPTIONS",
      "-u", "BASH_ENV",
      "-u", "ENV",
      process.execPath,
      ...finalWrapperArguments(finalNodeOptions),
    ],
    { stdio: "inherit", env }
  );
  managedChild(child, "[infisical] Failed to start the final application wrapper.");
}

function fetchProject(projectId, token, environment, path, label, { allowStoredSession = false } = {}) {
  if (!token && !allowStoredSession) {
    const infix = label === "shared" ? "_SHARED" : "";
    console.error(
      `[infisical] No credentials for the ${label} project ${projectId}. ` +
      `Set INFISICAL${infix}_CLIENT_ID + INFISICAL${infix}_CLIENT_SECRET (or INFISICAL${infix}_TOKEN).`
    );
    process.exit(2);
  }
  const result = spawnSync(
    "infisical",
    ["export", "--silent", "--projectId", projectId, "--env", environment, "--path", path, "--format", "json"],
    {
      encoding: "utf8",
      env: tokenCliEnvironment(token),
      // Keep a hard bound while avoiding Node's ~1 MiB default regression for
      // legitimate projects with larger multiline/certificate secret sets.
      maxBuffer: MAX_EXPORT_OUTPUT_BYTES,
    }
  );
  if (result.error) {
    console.error(`[infisical] Could not invoke 'infisical export' for project ${projectId}.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[infisical] 'infisical export' failed for project ${projectId} (exit ${result.status}). ` +
      "CLI output was suppressed because it may contain credentials."
    );
    process.exit(result.status || 1);
  }
  try {
    const parsed = JSON.parse(result.stdout || "");
    // Infisical CLI v0.43.98 serializes `--format json` as an array of
    // SingleEnvironmentVariable records (`{ key, value, ...metadata }`), not
    // as a flat key/value object. Keep this parser pinned to that documented
    // wire shape so metadata can never be mistaken for application secrets.
    if (!Array.isArray(parsed)) throw new Error("invalid shape");
    const secrets = Object.create(null);
    for (const entry of parsed) {
      if (!entry || Array.isArray(entry) || typeof entry !== "object") {
        throw new Error("invalid entry");
      }
      const { key, value } = entry;
      if (
        typeof key !== "string" || !key || key.includes("=") || key.includes("\0") ||
        typeof value !== "string" || value.includes("\0")
      ) {
        throw new Error("invalid entry");
      }
      if (Object.prototype.hasOwnProperty.call(secrets, key)) {
        throw new Error("duplicate entry");
      }
      secrets[key] = value;
    }
    return secrets;
  } catch {
    console.error(
      `[infisical] 'infisical export' returned invalid JSON for project ${projectId}. ` +
      "Raw output was suppressed because it may contain credentials."
    );
    process.exit(1);
  }
}

if (!sharedProjectId) {
  let appToken = resolveToken(appAuth, "app");
  clearAuth(sharedAuthOwn);

  if (watchEnabled) {
    // The CLI must own the watch/restart loop. Give it only nonsecret process
    // controls; Infisical supplies managed secrets and the final wrapper masks
    // every bootstrap credential before it starts the requested command.
    const runEnv = tokenCliEnvironment(appToken, {
      ...pickEnvironment(applicationBaseEnv, WATCH_RUNTIME_ALLOWLIST),
      SECRETS_SOURCE: "infisical",
    });
    const infisicalArgs = ["run", "--env", envName, "--path", secretsPath];
    if (appProjectId) infisicalArgs.push("--projectId", appProjectId);
    infisicalArgs.push(
      "--watch",
      "--",
      "/usr/bin/env",
      "-u", "NODE_OPTIONS",
      "-u", "BASH_ENV",
      "-u", "ENV",
      process.execPath,
      ...finalWrapperArguments(nodeOptions)
    );
    const child = spawn("infisical", infisicalArgs, { stdio: "inherit", env: runEnv });
    delete runEnv.INFISICAL_TOKEN;
    appToken = undefined;
    managedChild(child, "[infisical] Failed to start the Infisical watch process.");
  } else {
    // Export with the minimal CLI environment, then launch directly from the
    // runner so unrelated ambient app secrets never transit the third-party CLI.
    const appSecrets = fetchProject(
      appProjectId,
      appToken,
      envName,
      secretsPath,
      "app",
      { allowStoredSession: true }
    );
    appToken = undefined;
    console.log(`[infisical] exported ${Object.keys(appSecrets).length} app secret(s) from ${appProjectId}.`);
    runFinalApplication(buildFinalApplicationEnvironment({
      ...appSecrets,
      SECRETS_SOURCE: "infisical",
    }));
  }
} else {
  if (!appProjectId) {
    console.error("[infisical] INFISICAL_SHARED_PROJECT_ID is set but INFISICAL_PROJECT_ID is not.");
    process.exit(2);
  }

  const sharedHasOwnAuth = hasAuth(sharedAuthOwn);
  let appToken = resolveToken(appAuth, "app");
  let sharedToken;
  if (sharedHasOwnAuth) {
    sharedToken = resolveToken(sharedAuthOwn, "shared");
  } else {
    clearAuth(sharedAuthOwn);
    sharedToken = appToken;
  }

  const sharedSecrets = fetchProject(sharedProjectId, sharedToken, sharedEnv, sharedPath, "shared");
  const appSecrets = fetchProject(appProjectId, appToken, envName, secretsPath, "app");
  sharedToken = undefined;
  appToken = undefined;

  const overlap = Object.keys(appSecrets).filter((key) => key in sharedSecrets).length;
  console.log(
    `[infisical] merged ${Object.keys(sharedSecrets).length} shared (${sharedProjectId}) + ` +
    `${Object.keys(appSecrets).length} app (${appProjectId}) secret(s); app wins ${overlap} overlap(s).`
  );
  runFinalApplication(buildFinalApplicationEnvironment({
    ...sharedSecrets,
    ...appSecrets,
    SECRETS_SOURCE: "infisical",
  }));
}
