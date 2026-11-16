import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/admin/server-metrics/route";
import {
  SERVER_METRICS_CACHE_TTL_MS,
  resetServerMetricsCacheForTests,
} from "../src/lib/server-metrics-runtime";
import {
  describeMissingNetworkSeries,
  displayProviderText,
  markServerMetricsSnapshotStale,
  parseActionRunners,
  parseResourcesObservation,
  parseServerMetricsEnvelope,
  parseUnobservedHostFacts,
  resourceStatusTone,
  resourcesUnavailableHeadline,
} from "../app/admin/server/server-metrics-client";
import { ACTION_RUNNER_REPO, getActionRunners } from "../src/lib/server-metrics-runners";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import { normalizeCoolifyResources, normalizeHetznerServerResponse } from "../src/lib/server-metrics-shapes";

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) {
    headers[AUTHENTICATED_EMAIL_HEADER] = email;
    headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
  }
  return new Request("https://socratictrade.com/api/admin/server-metrics", { method: "GET", headers });
}

function providerResponse(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}

describe("server-metrics provider shape normalization", () => {
  it("extracts display strings from the real Hetzner server response shape", () => {
    const normalized = normalizeHetznerServerResponse({
      server: {
        name: "ubuntu-8gb-hel1-2",
        status: "running",
        server_type: { name: "cpx32", cores: 4, memory: 8 },
        location: { name: "hel1-dc2" },
        public_net: { ipv4: { ip: "135.181.192.190", blocked: false } },
      },
    });

    expect(normalized).toEqual({
      server: {
        name: "ubuntu-8gb-hel1-2",
        status: "running",
        serverType: "cpx32",
        cpus: 4,
        memoryGb: 8,
        location: "hel1-dc2",
        ip: "135.181.192.190",
      },
      warnings: [],
    });
  });

  it("reports malformed nested values and the client renders diagnostics instead of objects", () => {
    const malformedServerType = { cores: 4 };
    const malformedIpv4 = { blocked: false };
    const normalized = normalizeHetznerServerResponse({
      server: {
        server_type: malformedServerType,
        public_net: { ipv4: malformedIpv4 },
      },
    });

    expect(normalized.server.serverType).toBeUndefined();
    expect(normalized.server.ip).toBeUndefined();
    expect(normalized.warnings).toEqual([
      "Hetzner server_type.name was not a non-empty string.",
      "Hetzner public_net.ipv4.ip was not a non-empty string.",
    ]);
    expect(displayProviderText(malformedServerType, "vps", "server type")).toBe("Invalid server type");
    expect(displayProviderText(malformedIpv4, "127.0.0.1", "server IP")).toBe("Invalid server IP");
  });

  it("omits malformed Coolify resources while retaining valid services and backup tasks", () => {
    const normalized = normalizeCoolifyResources([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
      { uuid: "app-2", name: { rendered: "bad" }, type: "application", status: { state: "running" } },
      { uuid: "app-3", name: "usage monitor backups", type: "backup", status: "running:healthy" },
    ]);

    expect(normalized.resources).toEqual([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
      { uuid: "app-3", name: "usage monitor backups", type: "backup", status: "running:healthy" },
    ]);
    expect(normalized.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
    ]);
  });

  it("bounds Coolify normalization work and warning expansion", () => {
    const normalized = normalizeCoolifyResources(new Array(100_000).fill(null));

    expect(normalized.resources).toEqual([]);
    expect(normalized.warnings).toHaveLength(22);
    expect(normalized.warnings.at(-2)).toBe("480 additional malformed Coolify resources were omitted.");
    expect(normalized.warnings.at(-1)).toBe(
      "Coolify returned 100000 resources; only the first 500 were processed.",
    );
    expect(JSON.stringify(normalized).length).toBeLessThan(4_096);
  });

  it("validates successful client envelopes and marks retained data stale on transport failure", () => {
    const parsed = parseServerMetricsEnvelope({
      isProd: true,
      usesLocalHost: false,
      degraded: false,
      stale: false,
      cacheAgeSeconds: 2,
      hostInfo: { name: "prod-server" },
      resources: [],
      metrics: {
        cpu: [{ timestamp: 1, value: 10 }],
        diskRead: [],
        diskWrite: [],
        networkRx: [],
        networkTx: [],
      },
      asOf: "2026-07-18T12:00:00.000Z",
    });
    expect(parsed).toMatchObject({ isProd: true, stale: false, cacheAgeSeconds: 2 });
    expect(parseServerMetricsEnvelope({
      ...parsed,
      metrics: { ...parsed?.metrics, cpu: "not-an-array" },
    })).toBeUndefined();
    expect(markServerMetricsSnapshotStale(parsed ?? null, "network failed")).toMatchObject({
      degraded: true,
      stale: true,
      error: "network failed",
    });
  });
});

/**
 * The retired names that used to be hardcoded into the panel. `ci-cpx32` was deleted
 * 2026-07-31; none of these runners has ever existed in any fleet repository. No code path may
 * emit them again.
 */
const RETIRED_FABRICATED_RUNNER_NAMES = [
  "ci-cpx32",
  "socratic-ci",
  "congress-ci",
  "shared-ci",
  "usage-ci",
  "github-runner",
];

describe("GitHub Actions runner observability", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_MCP_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports an explicit unavailable state, with no runner rows, when no token is configured", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await getActionRunners();

    expect(result).toEqual({
      state: "unavailable",
      repo: ACTION_RUNNER_REPO,
      reason: "no-github-token",
      detail: expect.stringContaining("GH_TOKEN"),
    });
    expect(result).not.toHaveProperty("runners");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/ci-cpx32|running:healthy/);
  });

  it("returns exactly the runners GitHub reports, with GitHub's own reachability word", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({
      total_count: 2,
      runners: [
        {
          id: 42,
          name: "mac-xcode26-socratic",
          status: "online",
          busy: false,
          labels: [{ name: "self-hosted" }, { name: "macOS" }, { name: "xcode26" }],
        },
        { id: 43, name: "oracle-usage-ci", status: "offline", busy: true, labels: ["Linux"] },
      ],
    })));

    const result = await getActionRunners();

    expect(result).toEqual({
      state: "known",
      repo: ACTION_RUNNER_REPO,
      omittedCount: 0,
      runners: [
        {
          id: "42",
          name: "mac-xcode26-socratic",
          status: "online",
          busy: false,
          labels: ["self-hosted", "macOS", "xcode26"],
        },
        { id: "43", name: "oracle-usage-ci", status: "offline", busy: true, labels: ["Linux"] },
      ],
    });
    // No invented provenance suffix, and no health verdict layered onto reachability.
    expect(JSON.stringify(result)).not.toContain("Hetzner runner");
    expect(JSON.stringify(result)).not.toContain("healthy");
  });

  it("treats a measured empty runner list as a real answer rather than a failure", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({ total_count: 0, runners: [] })));

    const result = await getActionRunners();

    // "This repository has zero registered runners" is the single most important thing this
    // panel can report. The old code replaced it with six fabricated healthy rows.
    expect(result).toEqual({ state: "known", repo: ACTION_RUNNER_REPO, runners: [], omittedCount: 0 });
  });

  it.each([
    [500, "github-api-error"],
    [401, "github-api-error"],
    [403, "github-api-error"],
  ])("reports HTTP %i as unavailable/%s instead of fabricating runners", async (status, reason) => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({ message: "boom" }, status)));

    const result = await getActionRunners();

    expect(result).toMatchObject({ state: "unavailable", reason });
    expect(result).not.toHaveProperty("runners");
    expect((result as { detail: string }).detail).toContain(String(status));
  });

  it("reports an unexpected response shape and a transport failure distinctly", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({ runners: "not-an-array" })));
    expect(await getActionRunners()).toMatchObject({
      state: "unavailable",
      reason: "unexpected-shape",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await getActionRunners()).toMatchObject({
      state: "unavailable",
      reason: "request-failed",
    });
  });

  it("counts malformed runner entries instead of silently dropping them", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({
      runners: [
        { id: 1, name: "real-runner", status: "online", busy: false, labels: [] },
        { id: 2, name: { rendered: "bad" }, status: "online" },
        { id: 3, name: "no-status" },
      ],
    })));

    const result = await getActionRunners();

    expect(result).toMatchObject({ state: "known", omittedCount: 2 });
    expect((result as { runners: unknown[] }).runners).toHaveLength(1);
  });

  it("never emits a retired fabricated runner name on any outcome", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    const outcomes = [
      () => Promise.resolve(providerResponse({ runners: [] })),
      () => Promise.resolve(providerResponse({}, 500)),
      () => Promise.resolve(providerResponse({ runners: {} })),
      () => Promise.reject(new Error("network down")),
    ];

    for (const outcome of outcomes) {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(outcome));
      const serialized = JSON.stringify(await getActionRunners());
      for (const name of RETIRED_FABRICATED_RUNNER_NAMES) {
        expect(serialized).not.toContain(name);
      }
    }
  });
});

describe("server-metrics client rendering decisions", () => {
  it.each([
    ["running:healthy", "pos"],
    ["running", "pos"],
    ["running:unhealthy", "neg"],
    ["restarting:unhealthy", "neg"],
    ["exited:unhealthy", "neg"],
    ["exited", "neg"],
    ["restarting:starting", "warn"],
    ["degraded", "warn"],
  ])("tones Coolify status %s as %s", (status, tone) => {
    // "unhealthy".includes("healthy") is true, which is how every *:unhealthy container used
    // to render as a solid green dot.
    expect(resourceStatusTone(status)).toBe(tone);
  });

  it("distinguishes a missing Rx series, a missing Tx series, and no data at all", () => {
    expect(describeMissingNetworkSeries(0, 0)).toBe("no historical data available");
    expect(describeMissingNetworkSeries(1, 1)).toContain("only one sample");
    expect(describeMissingNetworkSeries(0, 12)).toContain("inbound (Rx)");
    expect(describeMissingNetworkSeries(12, 0)).toContain("outbound (Tx)");
  });

  it("parses both runner result states and rejects malformed ones", () => {
    expect(parseActionRunners({
      state: "known",
      repo: ACTION_RUNNER_REPO,
      omittedCount: 1,
      runners: [{ id: "1", name: "mac-xcode26-socratic", status: "online", busy: false, labels: ["macOS"] }],
    })).toEqual({
      state: "known",
      repo: ACTION_RUNNER_REPO,
      omittedCount: 1,
      runners: [{ id: "1", name: "mac-xcode26-socratic", status: "online", busy: false, labels: ["macOS"] }],
    });

    expect(parseActionRunners({
      state: "unavailable",
      repo: ACTION_RUNNER_REPO,
      reason: "no-github-token",
      detail: "No GitHub token is configured for this deployment.",
    })).toMatchObject({ state: "unavailable", reason: "no-github-token" });

    // A malformed payload must NOT collapse into an empty list; empty is a measured answer.
    expect(parseActionRunners({ state: "known", repo: ACTION_RUNNER_REPO, runners: "nope" })).toBeUndefined();
    expect(parseActionRunners({ state: "unavailable", repo: ACTION_RUNNER_REPO, reason: "made-up", detail: "x" })).toBeUndefined();
    expect(parseActionRunners(undefined)).toBeUndefined();
  });

  it("parses both service-observation states and rejects malformed ones", () => {
    expect(parseResourcesObservation({ state: "known" })).toEqual({ state: "known" });
    expect(parseResourcesObservation({
      state: "unavailable",
      reason: "coolify-request-failed",
      detail: "The Coolify resources endpoint could not be read on this refresh.",
    })).toMatchObject({ state: "unavailable", reason: "coolify-request-failed" });

    // A malformed or absent observation must NOT default to "known": that would restore the
    // exact bug this field exists to remove, asserting "Coolify reported no services" for a
    // read that never happened.
    expect(parseResourcesObservation({ state: "unavailable", reason: "invented", detail: "x" })).toBeUndefined();
    expect(parseResourcesObservation({ state: "unavailable", reason: "coolify-request-failed" })).toBeUndefined();
    expect(parseResourcesObservation({ state: "measured" })).toBeUndefined();
    expect(parseResourcesObservation(undefined)).toBeUndefined();
    expect(parseResourcesObservation("nope")).toBeUndefined();
  });

  it("headlines a never-queried service list differently from a failed read", () => {
    // "not queried" and "unavailable" are different facts for an operator: the first is a
    // wiring gap, the second is a live provider failure on a page that otherwise looks fresh.
    expect(resourcesUnavailableHeadline("coolify-not-configured")).toBe("services not queried");
    expect(resourcesUnavailableHeadline("coolify-partially-configured")).toBe("services not queried");
    expect(resourcesUnavailableHeadline("coolify-request-failed")).toBe("service list unavailable");
  });

  it("keeps only recognized unobserved-host facts", () => {
    expect(parseUnobservedHostFacts([
      { field: "uptime", reason: "coolify-server-metadata-absent", detail: "Host uptime is not measured." },
      { field: "somethingElse", reason: "x", detail: "y" },
      { field: "os" },
    ])).toEqual([
      { field: "uptime", reason: "coolify-server-metadata-absent", detail: "Host uptime is not measured." },
    ]);
    expect(parseUnobservedHostFacts("nope")).toEqual([]);
  });
});

describe("server-metrics API route", () => {
  beforeEach(() => {
    // The route probes GitHub Actions runners whenever ANY of these tokens resolves — and agent
    // machines now export GH_TOKEN in every shell (fleet keychain standardization, 2026-08-09),
    // which added a 5th fetch and broke every pinned call-count below. Hermetic tests must not
    // inherit machine credentials.
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_MCP_TOKEN", "");
  });
  afterEach(() => {
    resetServerMetricsCacheForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("DENIES access for non-admin users in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    
    const res = await GET(reqWithEmail("user@example.com"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("ALLOWS access and returns real local host metadata with empty remote data when not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    // Leave HETZNER_API_TOKEN etc unset
    vi.stubEnv("HETZNER_API_TOKEN", "");

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isProd).toBe(false);
    expect(body.usesLocalHost).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.hostInfo).toBeDefined();
    expect(body.hostInfo.cpus).toBeGreaterThan(0);
    // Coolify is unconfigured on this path, so there is nothing to list. This used to return
    // six fabricated "action-runner" rows describing machines that never existed.
    expect(body.resources).toEqual([]);
    // The empty list here is the ABSENCE of a measurement, and must say so.
    expect(body.resourcesObservation).toEqual({
      state: "unavailable",
      reason: "coolify-not-configured",
      detail: expect.stringContaining("not queried"),
    });
    expect(body.actionRunners).toEqual({
      state: "unavailable",
      repo: ACTION_RUNNER_REPO,
      reason: "no-github-token",
      detail: expect.stringContaining("No GitHub token is configured"),
    });
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
  });

  it("ALLOWS access and calls Hetzner/Coolify APIs when configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.hetzner.cloud/v1/servers/12345/metrics")) {
        return Promise.resolve(providerResponse({
            metrics: {
              time_series: {
                cpu: {
                  values: [
                    [1783652400, "351.748098"],
                    [1783652460, null],
                    [1783652520, "not-a-number"],
                  ]
                },
                "disk.0.bandwidth.read": {
                  values: [[1783652400, "1024"]]
                },
                "network.0.bandwidth.in": {
                  values: [[1783652400, "5000"]]
                },
                "network.0.bandwidth.out": {
                  values: [[1783652400, "2500"]]
                }
              }
            }
          }));
      }
      if (url.includes("api.hetzner.cloud/v1/servers/12345")) {
        return Promise.resolve(providerResponse({
            server: {
              name: "prod-server",
              status: "running",
              server_type: { name: "cx33", cores: 4, memory: 8 },
              location: { name: "hel1" },
              public_net: { ipv4: { ip: "135.181.192.190", blocked: false } }
            }
          }));
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid/resources")) {
        return Promise.resolve(providerResponse([
            { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
            { uuid: "app-2", name: { bad: true }, type: "application", status: { state: "running" } }
          ]));
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid")) {
        return Promise.resolve(providerResponse({
            name: "prod-server",
            server_metadata: {
              os: "Ubuntu 26.04",
              cpus: 4,
              memory_bytes: 8192000
            }
          }));
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.hostInfo.name).toBe("prod-server");
    expect(body.hostInfo.cpus).toBe(4);
    expect(body.hostInfo.serverType).toBe("cx33");
    expect(body.hostInfo.ip).toBe("135.181.192.190");
    expect(body.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
      "Hetzner metrics contained 2 malformed samples that were omitted.",
    ]);
    // Exactly the one well-formed Coolify resource. No runner rows are mixed into this list.
    expect(body.resources).toEqual([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
    ]);
    // Coolify was queried and answered, so this list IS a measurement.
    expect(body.resourcesObservation).toEqual({ state: "known" });
    expect(body.actionRunners.state).toBe("unavailable");
    expect(body.monitoredTarget).toEqual({
      hetznerServerId: "12345",
      coolifyServerUuid: "mock-coolify-uuid",
    });
    expect(body.metrics.cpu[0].value).toBeCloseTo(87.9370245);
    expect(body.metrics.cpu).toHaveLength(1);
    expect(body.metrics.diskRead[0].value).toBe(1024);
    expect(body.metrics.networkRx[0].value).toBe(5000);
    expect(body.metrics.networkTx[0].value).toBe(2500);

    const cachedRes = await GET(reqWithEmail("admin@example.com"));
    expect(cachedRes.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("does not infer the monitored target is production from this app runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: { time_series: {} } }
        : { server: { name: "monitored-host", status: "running", server_type: { cores: 4 } } },
    ))));

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usesLocalHost).toBe(false);
    expect(body.isProd).toBe(false);
  });

  it("returns HTTP 200 with valid data when one provider endpoint fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) return Promise.resolve(providerResponse({}, 503));
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({
          metrics: { time_series: { cpu: { values: [[1783652400, "40"]] } } },
        }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "verified-host", status: "running", server_type: { name: "cx22" } },
        }));
      }
      return Promise.resolve(providerResponse({ name: "coolify-host", server_metadata: {} }));
    }));

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo.name).toBe("verified-host");
    // The Coolify resources call 503'd, so there is nothing to list. Not six invented rows.
    expect(body.resources).toEqual([]);
    // ...and the empty list must be marked as a FAILED READ, not as a measured zero. This is
    // the dangerous path: the Hetzner reads succeeded, so successfulProviderReads > 0 and
    // neither stale-cache branch fires — the page renders fresh while the service list is
    // simply unknown. The card used to assert "coolify reported no services for this server".
    expect(body.stale).toBe(false);
    expect(body.resourcesObservation).toEqual({
      state: "unavailable",
      reason: "coolify-request-failed",
      detail: expect.stringContaining("could not be read"),
    });
    expect(body.metrics.cpu).toEqual([]);
    expect(body.warnings).toEqual(expect.arrayContaining([
      "Coolify resources returned HTTP 503.",
      "Hetzner aggregate CPU metrics were omitted because the server core count was unavailable.",
    ]));
  });

  it("marks a genuinely empty Coolify answer as measured, not as a failed read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "");
    vi.stubEnv("HETZNER_SERVER_ID", "");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(
      url.includes("/resources")
        ? providerResponse([])
        : providerResponse({ name: "coolify-host", server_metadata: null }),
    )));

    const body = await (await GET(reqWithEmail("admin@example.com"))).json();

    // Zero services IS an answer when Coolify actually answered, and it must stay
    // distinguishable from the three ways of not knowing.
    expect(body.resources).toEqual([]);
    expect(body.resourcesObservation).toEqual({ state: "known" });
  });

  it("does not claim a service measurement when Coolify is only half-configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    // A token with no server UUID: the route skips the Coolify block entirely, so nothing is
    // ever requested and `resources: []` describes no measurement at all.
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: { time_series: {} } }
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    )));
    vi.stubGlobal("fetch", fetchMock);

    const body = await (await GET(reqWithEmail("admin@example.com"))).json();

    expect(body.resources).toEqual([]);
    expect(body.resourcesObservation).toEqual({
      state: "unavailable",
      reason: "coolify-partially-configured",
      detail: expect.stringContaining("incomplete"),
    });
    // Nothing was requested from Coolify at all.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("host.jays.services");
    }
  });

  it("bounds provider response bodies while retaining valid sibling data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/metrics")) {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(600 * 1024), "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(providerResponse({
        server: { name: "verified-host", status: "running", server_type: { cores: 4 } },
      }));
    }));

    const response = await GET(reqWithEmail("admin@example.com"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo.name).toBe("verified-host");
    expect(body.warnings).toContain("Hetzner metrics returned invalid or oversized JSON.");
  });

  it.each([
    ["missing time_series", { metrics: {} }],
    ["non-object time_series", { metrics: { time_series: [] } }],
  ])("rejects a Hetzner metrics envelope with %s", async (_description, malformedPayload) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? malformedPayload
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    ))));

    const response = await GET(reqWithEmail("admin@example.com"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
    expect(body.warnings).toContain("Hetzner metrics returned an invalid metrics envelope.");
  });

  it("retains the last metric series when Hetzner returns a malformed metrics envelope", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-18T12:00:00.000Z");
    vi.setSystemTime(initialTime);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");

    const mockFetch = vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: { time_series: { cpu: { values: [[1783652400, "40"]] } } } }
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    )));
    vi.stubGlobal("fetch", mockFetch);

    const initial = await GET(reqWithEmail("admin@example.com"));
    const initialBody = await initial.json();
    expect(initialBody.metrics.cpu).toEqual([{ timestamp: 1783652400, value: 10 }]);

    vi.setSystemTime(new Date(initialTime.getTime() + SERVER_METRICS_CACHE_TTL_MS + 1));
    mockFetch.mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: {} }
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    )));

    const stale = await GET(reqWithEmail("admin@example.com"));
    const staleBody = await stale.json();
    expect(stale.status).toBe(200);
    expect(staleBody.degraded).toBe(true);
    expect(staleBody.stale).toBe(true);
    expect(staleBody.asOf).toBe(initialBody.asOf);
    expect(staleBody.metrics.cpu).toEqual(initialBody.metrics.cpu);
    expect(staleBody.warnings).toEqual(expect.arrayContaining([
      "Hetzner metrics returned an invalid metrics envelope.",
      "The displayed infrastructure metrics are stale.",
    ]));
  });

  it("does not misreport partial production configuration as the local host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "token-without-server-uuid");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({ metrics: { time_series: {} } }));
      }
      return Promise.resolve(providerResponse({
        server: {
          name: "prod-server",
          status: "running",
          server_type: { name: "cx33", cores: 4 },
        },
      }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.configuration).toEqual({ hetzner: "configured", coolify: "partial" });
    expect(body.hostInfo.name).toBe("prod-server");
    expect(body.hostInfo.uptimeSeconds).toBeUndefined();
    expect(body.warnings).toContain(
      "Coolify configuration is incomplete; both API token and server UUID are required.",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfigured production values unavailable instead of using process host data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "");
    vi.stubEnv("HETZNER_SERVER_ID", "");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo).toEqual({ status: "unknown" });
    expect(body.metrics.cpu).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("explains WHY host memory, uptime, OS and disk capacity are blank instead of bare 'Unavailable'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "159792099");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    // Mirrors the live box: Coolify answers, but `server_metadata` is null because its metrics
    // collection is disabled, and its own host record is the self-referential "localhost".
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) return Promise.resolve(providerResponse([]));
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({ metrics: { time_series: {} } }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "fleet-hetzner-nbg1", status: "running", server_type: { name: "cx43", cores: 8, memory: 16 } },
        }));
      }
      return Promise.resolve(providerResponse({ name: "localhost", server_metadata: null }));
    }));

    const body = await (await GET(reqWithEmail("admin@example.com"))).json();

    const byField = Object.fromEntries(
      (body.unobservedHostFacts as Array<{ field: string; reason: string; detail: string }>)
        .map((fact) => [fact.field, fact]),
    );
    expect(byField.memoryUtilization.reason).toBe("coolify-server-metadata-absent");
    expect(byField.uptime.reason).toBe("coolify-server-metadata-absent");
    expect(byField.os.reason).toBe("coolify-server-metadata-absent");
    expect(byField.diskCapacity.reason).toBe("not-collected-by-providers");
    expect(byField.diskCapacity.detail).toContain("bandwidth");
    // Hetzner's name wins, and Coolify's self-referential "localhost" is never substituted.
    expect(body.hostInfo.name).toBe("fleet-hetzner-nbg1");
  });

  it("does not substitute Coolify's self-referential host record when Hetzner metadata fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "159792099");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.hetzner.cloud")) return Promise.resolve(providerResponse({}, 404));
      if (url.includes("/resources")) return Promise.resolve(providerResponse([]));
      return Promise.resolve(providerResponse({ name: "localhost", server_metadata: null }));
    }));

    const body = await (await GET(reqWithEmail("admin@example.com"))).json();

    // Showing "Host Server: localhost" on the production panel disguised a provider outage as
    // a plausible hostname.
    expect(body.hostInfo.name).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("localhost");
    expect(body.degraded).toBe(true);
  });

  it("serves no fabricated infrastructure rows in a production-shaped payload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "159792099");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) {
        return Promise.resolve(providerResponse([
          { uuid: "app-1", name: "socratic-app", type: "application", status: "running:healthy" },
          { uuid: "app-2", name: "congress-trade", type: "application", status: "running:healthy" },
          { uuid: "app-3", name: "usage-monitor", type: "application", status: "running:healthy" },
        ]));
      }
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({ metrics: { time_series: {} } }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "fleet-hetzner-nbg1", status: "running", server_type: { name: "cx43", cores: 8, memory: 16 } },
        }));
      }
      return Promise.resolve(providerResponse({ name: "localhost", server_metadata: null }));
    }));

    const body = await (await GET(reqWithEmail("admin@example.com"))).json();
    const serialized = JSON.stringify(body);

    // Coolify really does report exactly three resources on this box. The panel used to show
    // nine, the extra six being invented runners on a CI server deleted 2026-07-31.
    expect(body.resources).toHaveLength(3);
    for (const name of RETIRED_FABRICATED_RUNNER_NAMES) {
      expect(serialized).not.toContain(name);
    }
    expect(body.actionRunners).toMatchObject({ state: "unavailable", reason: "no-github-token" });
  });

  it("returns an explicit degraded receipt without fabricated host data on provider failures", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) return Promise.resolve(providerResponse({}, 401));
      if (url.includes("api.hetzner.cloud") && url.includes("/metrics")) {
        return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(providerResponse({}, 403));
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.isProd).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.error).toBe("One or more infrastructure providers could not be queried.");
    expect(body.hostInfo.status).toBe("unknown");
    expect(body.resources).toEqual([]);
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
    expect(body.warnings).toEqual(expect.arrayContaining([
      "Coolify server metadata returned HTTP 403.",
      "Coolify resources returned HTTP 401.",
      "Hetzner server metadata returned HTTP 403.",
      "Hetzner metrics was unavailable.",
    ]));
    expect(JSON.stringify(body)).not.toContain("135.181.192.190");
    expect(JSON.stringify(body)).not.toContain("hel1");
  });

  it("single-flights concurrent dashboard refreshes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      await gate;
      if (url.includes("/resources")) return providerResponse([]);
      if (url.includes("/metrics")) return providerResponse({ metrics: { time_series: {} } });
      if (url.includes("api.hetzner.cloud")) {
        return providerResponse({ server: { status: "running", server_type: { cores: 4 } } });
      }
      return providerResponse({ server_metadata: { cpus: 4 } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const first = GET(reqWithEmail("admin@example.com"));
    const second = GET(reqWithEmail("admin@example.com"));
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("serves a bounded stale snapshot when a refresh loses all providers", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-18T12:00:00.000Z");
    vi.setSystemTime(initialTime);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const healthyFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) {
        return Promise.resolve(providerResponse([
          { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
        ]));
      }
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({
          metrics: {
            time_series: {
              cpu: { values: [[1783652400, "40"]] },
              "disk.0.bandwidth.read": { values: [[1783652400, "1024"]] },
              "disk.0.bandwidth.write": { values: [[1783652400, "2048"]] },
              "network.0.bandwidth.in": { values: [[1783652400, "4096"]] },
              "network.0.bandwidth.out": { values: [[1783652400, "8192"]] },
            },
          },
        }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "last-known-host", status: "running", server_type: { cores: 4 } },
        }));
      }
      return Promise.resolve(providerResponse({ server_metadata: { cpus: 4 } }));
    });
    vi.stubGlobal("fetch", healthyFetch);
    const initial = await GET(reqWithEmail("admin@example.com"));
    const initialBody = await initial.json();

    vi.setSystemTime(new Date(initialTime.getTime() + SERVER_METRICS_CACHE_TTL_MS + 1));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider outage")));
    const stale = await GET(reqWithEmail("admin@example.com"));
    const staleBody = await stale.json();

    expect(stale.status).toBe(200);
    expect(staleBody.stale).toBe(true);
    expect(staleBody.degraded).toBe(true);
    expect(staleBody.asOf).toBe(initialBody.asOf);
    expect(staleBody.hostInfo.name).toBe("last-known-host");
    expect(staleBody.resources).toEqual(initialBody.resources);
    expect(staleBody.metrics).toEqual(initialBody.metrics);
    expect(staleBody.cacheAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(staleBody.error).toContain("last successful snapshot");

    vi.setSystemTime(new Date(initialTime.getTime() + 10 * 60_000 + 1));
    const expired = await GET(reqWithEmail("admin@example.com"));
    const expiredBody = await expired.json();
    expect(expired.status).toBe(200);
    expect(expiredBody.stale).toBe(false);
    expect(expiredBody.hostInfo).toEqual({ status: "unknown" });
    expect(expiredBody.asOf).not.toBe(initialBody.asOf);
  });
});
