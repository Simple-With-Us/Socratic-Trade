#!/usr/bin/env node

// Final credential boundary for commands launched after Infisical injection.
// Empty masks are deliberate: Next's dotenv loader does not overwrite an
// already-present key, so `.env.local` cannot restore a long-lived credential
// after this wrapper removes the value supplied by the runner or Infisical.

import { spawn } from "node:child_process";
import { INFISICAL_FINAL_APP_MASK_KEYS } from "./infisical-bootstrap-env.mjs";

const args = process.argv.slice(2);
let nodeOptions;
if (args[0] === "--node-options-base64") {
  if (args.length < 3) {
    console.error("[infisical] Invalid final application wrapper arguments.");
    process.exit(2);
  }
  try {
    nodeOptions = Buffer.from(args[1], "base64").toString("utf8");
  } catch {
    console.error("[infisical] Invalid final application wrapper arguments.");
    process.exit(2);
  }
  args.splice(0, 2);
}
const separatorIndex = args.indexOf("--");
const command = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args;

if (command.length === 0) {
  console.error("Usage: node scripts/infisical-app-child.mjs -- <command...>");
  process.exit(2);
}

for (const key of INFISICAL_FINAL_APP_MASK_KEYS) process.env[key] = "";
process.env.SECRETS_SOURCE = "infisical";
if (nodeOptions !== undefined) process.env.NODE_OPTIONS = nodeOptions;
else delete process.env.NODE_OPTIONS;

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: process.env,
});

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalHandlers = new Map();
for (const signal of forwardedSignals) {
  const handler = () => child.kill(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

child.on("error", () => {
  removeSignalHandlers();
  console.error("[infisical] Failed to start the final application command.");
  process.exit(1);
});

const SIGNAL_EXIT_CODES = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

child.on("exit", (code, signal) => {
  removeSignalHandlers();
  if (signal) {
    // Never re-raise the signal on ourselves: in a container this wrapper can sit at or
    // near pid 1, where the kernel ignores default-disposition signals -- the re-raise
    // no-ops and node drains to a bogus "clean" exit 0 (2026-08-02 outage; see
    // docs/rollouts/2026-08-02-exit0-outage-audit.md). Translate to 128+N instead.
    const exitCode = 128 + (SIGNAL_EXIT_CODES[signal] ?? 15);
    console.error(`[infisical] application terminated by ${signal}; exiting ${exitCode}`);
    process.exit(exitCode);
  }
  process.exit(code ?? 1);
});
