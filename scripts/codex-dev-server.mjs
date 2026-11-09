#!/usr/bin/env node

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const PORT = 3001;
const HOST = "127.0.0.1";
const MAX_RESTARTS = 2;

let child = null;
let stopping = false;

function log(message) {
  process.stderr.write(`[codex-dev] ${message}\n`);
}

function pidsListeningOnCodexPort() {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-tiTCP:${PORT}`, "-sTCP:LISTEN"],
      (error, stdout) => {
        if (error && !stdout) {
          resolve([]);
          return;
        }

        const pids = stdout
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

        resolve([...new Set(pids)]);
      },
    );
  });
}

async function waitForPortToClear(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pids = await pidsListeningOnCodexPort();
    if (pids.length === 0) {
      return true;
    }
    await wait(250);
  }

  return false;
}

async function signalPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        log(`could not send ${signal} to PID ${pid}: ${error.message}`);
      }
    }
  }
}

async function freeCodexPort() {
  const pids = await pidsListeningOnCodexPort();
  if (pids.length === 0) {
    return;
  }

  log(`freeing port ${PORT} from PID(s): ${pids.join(", ")}`);
  await signalPids(pids, "SIGTERM");

  if (await waitForPortToClear()) {
    return;
  }

  const remaining = await pidsListeningOnCodexPort();
  if (remaining.length > 0) {
    log(`port ${PORT} still occupied; forcing PID(s): ${remaining.join(", ")}`);
    await signalPids(remaining, "SIGKILL");
  }

  if (!(await waitForPortToClear())) {
    throw new Error(`port ${PORT} is still occupied after restart cleanup`);
  }
}

function outputMentionsWrongPort(text) {
  const matches = text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/g);

  for (const match of matches) {
    if (Number.parseInt(match[1], 10) !== PORT) {
      return true;
    }
  }

  return false;
}

function startNextDev() {
  return new Promise((resolve) => {
    let sawWrongPort = false;

    log(`starting Next dev on http://${HOST}:${PORT}`);
    child = spawn("next", ["dev", "--hostname", HOST, "--port", String(PORT)], {
      env: {
        ...process.env,
        HOSTNAME: HOST,
        PORT: String(PORT),
      },
      shell: process.platform === "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });

    const handleOutput = (stream, chunk) => {
      stream.write(chunk);
      const text = chunk.toString();

      if (
        !stopping &&
        !sawWrongPort &&
        (text.includes(`Port ${PORT} is in use`) || outputMentionsWrongPort(text))
      ) {
        sawWrongPort = true;
        log(`Next did not bind to port ${PORT}; restarting on ${PORT}`);
        child?.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => handleOutput(process.stdout, chunk));
    child.stderr.on("data", (chunk) => handleOutput(process.stderr, chunk));
    child.on("error", (error) => {
      log(`failed to start Next dev: ${error.message}`);
      child = null;
      resolve({ code: 1, sawWrongPort });
    });
    child.on("exit", (code, signal) => {
      child = null;
      const exitCode =
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      resolve({ code: exitCode, sawWrongPort });
    });
  });
}

function stop(signal) {
  stopping = true;

  if (child && !child.killed) {
    child.kill(signal);
    return;
  }

  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

for (let attempt = 0; attempt <= MAX_RESTARTS; attempt += 1) {
  await freeCodexPort();
  const result = await startNextDev();

  if (stopping || !result.sawWrongPort) {
    process.exit(result.code);
  }

  if (attempt === MAX_RESTARTS) {
    log(`could not keep Next dev on port ${PORT} after ${MAX_RESTARTS + 1} attempts`);
    process.exit(result.code || 1);
  }

  log(`retrying Codex dev server on port ${PORT}`);
}
