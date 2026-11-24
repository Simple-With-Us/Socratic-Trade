import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import {
  EXIT_CODE_SPONTANEOUS_CLEAN_RETAG,
  installProcessExitGuard,
} from "../src/lib/exit-guard";

function makeFakeProc(env: Record<string, string | undefined> = {}) {
  const emitter = new EventEmitter();
  const exitCalls: Array<number | string | null | undefined> = [];
  const logs: string[] = [];
  const proc = Object.assign(emitter, {
    env,
    pid: 4242,
    exitCode: undefined as number | string | null | undefined,
    exit: ((code?: number | string | null) => {
      exitCalls.push(code);
    }) as unknown as NodeJS.Process["exit"],
  }) as unknown as NodeJS.Process;
  return { proc, exitCalls, logs, log: (line: string) => logs.push(line) };
}

describe("exit-guard", () => {
  it("is inactive outside production unless forced", () => {
    const { proc, exitCalls, log } = makeFakeProc({ NODE_ENV: "test" });
    const originalExit = proc.exit;
    expect(installProcessExitGuard(proc, { log })).toBe(false);
    expect(proc.exit).toBe(originalExit);
    proc.exit(0);
    expect(exitCalls).toEqual([0]);
  });

  it("activates on NODE_ENV=production and can be disabled with EXIT_GUARD=off", () => {
    const prodProc = makeFakeProc({ NODE_ENV: "production" });
    expect(installProcessExitGuard(prodProc.proc, { log: prodProc.log })).toBe(true);
    const offProc = makeFakeProc({ NODE_ENV: "production", EXIT_GUARD: "off" });
    expect(installProcessExitGuard(offProc.proc, { log: offProc.log })).toBe(false);
  });

  it("re-tags a spontaneous process.exit(0) to the non-zero re-tag code", () => {
    const { proc, exitCalls, logs, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    proc.exit(0);
    expect(exitCalls).toEqual([EXIT_CODE_SPONTANEOUS_CLEAN_RETAG]);
    expect(logs.join("\n")).toContain("FATAL: spontaneous process.exit(0)");
  });

  it("treats an argument-less exit with no exitCode as a spontaneous exit 0", () => {
    const { proc, exitCalls, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    proc.exit();
    expect(exitCalls).toEqual([EXIT_CODE_SPONTANEOUS_CLEAN_RETAG]);
  });

  it("lets exit(0) through unchanged after a stop signal, with a receipt", () => {
    const { proc, exitCalls, logs, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    // A second listener stands in for Next's own cleanup handler, so the
    // guard's lone-handler fallback does not fire.
    proc.on("SIGTERM", () => {});
    proc.emit("SIGTERM");
    proc.exit(0);
    expect(exitCalls).toEqual([0]);
    expect(logs.join("\n")).toContain("received SIGTERM");
    expect(logs.join("\n")).toContain("process.exit(0) after SIGTERM");
  });

  it("passes deliberate non-zero exits through unchanged (R2 kill-switch contract)", () => {
    const { proc, exitCalls, logs, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    proc.exit(41);
    expect(exitCalls).toEqual([41]);
    expect(logs.join("\n")).toContain("process.exit(41)");
  });

  it("performs the default action itself when it is the only stop-signal handler", () => {
    const { proc, exitCalls, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    proc.emit("SIGTERM");
    expect(exitCalls).toEqual([143]);
  });

  it("installs only once per process", () => {
    const { proc, log } = makeFakeProc({ NODE_ENV: "production" });
    expect(installProcessExitGuard(proc, { log })).toBe(true);
    expect(installProcessExitGuard(proc, { log })).toBe(false);
  });

  it("warns about an event-loop-drain exit 0 without a stop signal", () => {
    const { proc, logs, log } = makeFakeProc({ NODE_ENV: "production" });
    installProcessExitGuard(proc, { log });
    (proc as unknown as EventEmitter).emit("exit", 0);
    expect(logs.join("\n")).toContain("event-loop drain");
  });
});

// ST-4661: end-to-end probe in a real child process. The fake-proc tests above
// prove the guard logic; these prove the OS-level exit codes a container
// runtime actually observes. The child installs the guard through the same
// entry the production path uses (installProcessExitGuard(process), armed by
// NODE_ENV=production exactly as instrumentation.ts does, minus the durable
// receipt receiver) and runs the TypeScript source via the repo's tsx loader.
describe("exit-guard child-process probe", () => {
  const guardUrl = pathToFileURL(new URL("../src/lib/exit-guard.ts", import.meta.url).pathname).href;
  const prelude =
    `import { installProcessExitGuard } from ${JSON.stringify(guardUrl)};` +
    ` installProcessExitGuard(process);`;

  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env.EXIT_GUARD;
    return env;
  }

  it("re-tags a spontaneous process.exit(0) to exit code 43 in a real process", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `${prelude} process.exit(0);`], {
      encoding: "utf8",
      env: childEnv(),
      timeout: 30_000
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(EXIT_CODE_SPONTANEOUS_CLEAN_RETAG);
    expect(result.stderr).toContain("FATAL: spontaneous process.exit(0)");
  });

  it("exits 143 on SIGTERM without misreporting it as a spontaneous exit 0", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", `${prelude} console.log("READY"); setInterval(() => {}, 1000);`],
      { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never became READY")), 20_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      child.kill("SIGTERM");
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      // The guard is the only SIGTERM handler in the probe, so it performs the
      // default action itself: 128 + 15. Never 0, never the 43 re-tag.
      expect(signal).toBeNull();
      expect(code).toBe(143);
      expect(stderr).toContain("received SIGTERM");
      expect(stderr).not.toContain("FATAL: spontaneous process.exit(0)");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
