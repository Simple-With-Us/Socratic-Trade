import { createHash, timingSafeEqual } from "crypto";
import {
  getInternalSetting,
  getUserApiKey,
  LOCAL_USER,
  setInternalSetting,
  USER_API_KEY_DELETION_TOMBSTONE,
} from "./db";

const ENABLED_ENV = "INFISICAL_ST_PRIMARY_WRITER_ENABLED";
const CLIENT_ID_ENV = "INFISICAL_ST_PRIMARY_WRITER_CLIENT_ID";
const CLIENT_SECRET_ENV = "INFISICAL_ST_PRIMARY_WRITER_CLIENT_SECRET";
const BASE_URL = "https://app.infisical.com";
const PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
const ENVIRONMENT = "prod";
const SECRET_PATH = "/usage-monitor/st-primary/v1";
const MANIFEST_SECRET = "BRIDGE_MANIFEST_V1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024;

export const ST_PRIMARY_BRIDGE_WRITER_STATE_KEY =
  "st-primary-bridge-writer:published-manifest";
export const ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY =
  "st-primary-bridge-writer:last-attempt";
export const ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY =
  "st-primary-bridge-writer:last-success";
export const ST_PRIMARY_BRIDGE_WRITER_LAST_OUTCOME_KEY =
  "st-primary-bridge-writer:last-outcome";
export const ST_PRIMARY_BRIDGE_WRITER_SUCCESS_INTERVAL_MS = 5 * 60_000;
export const ST_PRIMARY_BRIDGE_WRITER_RETRY_INTERVAL_MS = 60_000;

const ENTRY_CONTRACT = [
  {
    id: "gemini.apiKey",
    service: "gemini",
    providerName: "google-ai",
    capability: "apiKey",
    secretName: "GEMINI_API_KEY",
  },
  {
    id: "deepseek.apiKey",
    service: "deepseek",
    providerName: "deepseek",
    capability: "apiKey",
    secretName: "DEEPSEEK_API_KEY",
  },
] as const;

const ALLOWED_SECRET_NAMES = new Set([
  MANIFEST_SECRET,
  ...ENTRY_CONTRACT.map(({ secretName }) => secretName),
]);

type EntryId = (typeof ENTRY_CONTRACT)[number]["id"];
type EntryStatus = "active" | "revoked";

export interface StPrimaryBridgeManifestEntry {
  id: EntryId;
  providerName: "google-ai" | "deepseek";
  capability: "apiKey";
  secretName: "GEMINI_API_KEY" | "DEEPSEEK_API_KEY";
  status: EntryStatus;
  fingerprint: string | null;
}

export interface StPrimaryBridgeManifest {
  schemaVersion: 1;
  source: "socratic-trade-primary";
  complete: true;
  sequence: number;
  entries: StPrimaryBridgeManifestEntry[];
}

interface DesiredEntry extends StPrimaryBridgeManifestEntry {
  value?: string;
}

interface PublishedState {
  schemaVersion: 1;
  sequence: number;
  manifestDigest: string;
}

interface RemoteSecret {
  found: boolean;
  value?: string;
}

export type StPrimaryBridgeWriterStatus =
  | "disabled"
  | "unconfigured"
  | "not_due"
  | "unchanged"
  | "synced"
  | "error";

export interface StPrimaryBridgeWriterResult {
  status: StPrimaryBridgeWriterStatus;
  sequence?: number;
  active?: number;
  revoked?: number;
  errorCode?: string;
}

export interface StPrimaryBridgeWriterOptions {
  /** Test seam only. Production always uses the fixed Infisical Cloud URL. */
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  enabled?: boolean;
  fetcher?: typeof fetch;
  force?: boolean;
  now?: number;
}

class BridgeWriterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BridgeWriterError";
  }
}

const inFlightHost = globalThis as unknown as {
  __stPrimaryBridgeWriterInFlight?: Promise<StPrimaryBridgeWriterResult>;
  __stPrimaryBridgeWriterRequestedGeneration?: number;
  __stPrimaryBridgeWriterCompletedGeneration?: number;
};

function enabledValue(value: string | undefined): boolean {
  return new Set(["1", "true", "on", "yes"]).has(
    String(value ?? "").trim().toLowerCase()
  );
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameFingerprint(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejectDuplicateJsonObjectMembers(input: string): void {
  let index = 0;
  const invalid = (): never => {
    throw new BridgeWriterError("manifest_invalid_json");
  };
  const skipWhitespace = () => {
    while (/\s/.test(input[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    if (input[index] !== '"') return invalid();
    const start = index++;
    let escaped = false;
    while (index < input.length) {
      const char = input[index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        try {
          return JSON.parse(input.slice(start, index)) as string;
        } catch {
          return invalid();
        }
      }
    }
    return invalid();
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (input[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (input[index] === "}") {
        index += 1;
        return;
      }
      while (index < input.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new BridgeWriterError("manifest_duplicate_member");
        keys.add(key);
        skipWhitespace();
        if (input[index++] !== ":") return invalid();
        parseValue();
        skipWhitespace();
        const delimiter = input[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") return invalid();
      }
      return invalid();
    }
    if (input[index] === "[") {
      index += 1;
      skipWhitespace();
      if (input[index] === "]") {
        index += 1;
        return;
      }
      while (index < input.length) {
        parseValue();
        skipWhitespace();
        const delimiter = input[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") return invalid();
      }
      return invalid();
    }
    if (input[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index += 1;
    if (index === start) return invalid();
  };

  parseValue();
  skipWhitespace();
  if (index !== input.length) invalid();
}

function parseManifest(raw: string): StPrimaryBridgeManifest {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new BridgeWriterError("manifest_too_large");
  }
  rejectDuplicateJsonObjectMembers(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeWriterError("manifest_invalid_json");
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ["schemaVersion", "source", "complete", "sequence", "entries"]) ||
    parsed.schemaVersion !== 1 ||
    parsed.source !== "socratic-trade-primary" ||
    parsed.complete !== true ||
    !Number.isSafeInteger(parsed.sequence) ||
    (parsed.sequence as number) < 1 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length !== ENTRY_CONTRACT.length
  ) {
    throw new BridgeWriterError("manifest_invalid");
  }

  const entries = new Map<EntryId, StPrimaryBridgeManifestEntry>();
  for (const value of parsed.entries) {
    if (
      !isRecord(value) ||
      !exactKeys(value, ["id", "providerName", "capability", "secretName", "status", "fingerprint"]) ||
      (value.id !== "gemini.apiKey" && value.id !== "deepseek.apiKey") ||
      entries.has(value.id)
    ) {
      throw new BridgeWriterError("manifest_entries_invalid");
    }
    const contract = ENTRY_CONTRACT.find(({ id }) => id === value.id)!;
    if (
      value.providerName !== contract.providerName ||
      value.capability !== contract.capability ||
      value.secretName !== contract.secretName ||
      (value.status !== "active" && value.status !== "revoked") ||
      (value.status === "active"
        ? typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        : value.fingerprint !== null)
    ) {
      throw new BridgeWriterError("manifest_entries_invalid");
    }
    entries.set(value.id, value as unknown as StPrimaryBridgeManifestEntry);
  }
  return {
    schemaVersion: 1,
    source: "socratic-trade-primary",
    complete: true,
    sequence: parsed.sequence as number,
    entries: ENTRY_CONTRACT.map(({ id }) => entries.get(id)!),
  };
}

function manifestString(manifest: StPrimaryBridgeManifest): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: "socratic-trade-primary",
    complete: true,
    sequence: manifest.sequence,
    entries: ENTRY_CONTRACT.map(({ id }) => {
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new BridgeWriterError("manifest_entries_invalid");
      return {
        id: entry.id,
        providerName: entry.providerName,
        capability: entry.capability,
        secretName: entry.secretName,
        status: entry.status,
        fingerprint: entry.fingerprint,
      };
    }),
  });
}

function manifestDigest(manifest: StPrimaryBridgeManifest): string {
  return fingerprint(manifestString(manifest));
}

function manifestContentDigest(entries: readonly StPrimaryBridgeManifestEntry[]): string {
  return fingerprint(JSON.stringify(ENTRY_CONTRACT.map(({ id }) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new BridgeWriterError("manifest_entries_invalid");
    return {
      id: entry.id,
      providerName: entry.providerName,
      capability: entry.capability,
      secretName: entry.secretName,
      status: entry.status,
      fingerprint: entry.fingerprint,
    };
  })));
}

function desiredEntries(): DesiredEntry[] {
  return ENTRY_CONTRACT.map((contract) => {
    // The source account is a compile-time constant. No caller, request, env,
    // or manifest can select another Socratic user.
    const stored = getUserApiKey(LOCAL_USER, contract.service, { includeDeleted: true });
    if (!stored || stored.apiKey === USER_API_KEY_DELETION_TOMBSTONE) {
      return {
        id: contract.id,
        providerName: contract.providerName,
        capability: contract.capability,
        secretName: contract.secretName,
        status: "revoked",
        fingerprint: null,
      };
    }
    if (
      !stored.apiKey ||
      stored.apiKey.includes("\0") ||
      Buffer.byteLength(stored.apiKey, "utf8") > MAX_SECRET_VALUE_BYTES
    ) {
      // An undecryptable/corrupt local row is not a user revocation. Retain the
      // last remote complete set until the local row can be repaired.
      throw new BridgeWriterError("local_key_unreadable");
    }
    return {
      id: contract.id,
      providerName: contract.providerName,
      capability: contract.capability,
      secretName: contract.secretName,
      status: "active",
      fingerprint: fingerprint(stored.apiKey),
      value: stored.apiKey,
    };
  });
}

function readPublishedState(): PublishedState | undefined {
  const value = getInternalSetting<unknown>(ST_PRIMARY_BRIDGE_WRITER_STATE_KEY);
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "sequence", "manifestDigest"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.manifestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifestDigest)
  ) {
    throw new BridgeWriterError("local_state_invalid");
  }
  return value as unknown as PublishedState;
}

interface JsonHttpResponse {
  ok: boolean;
  status: number;
  body?: Record<string, unknown>;
}

async function fetchJsonBounded(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {}
): Promise<JsonHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      controller.abort();
      void cancelBodyQuietly(response.body);
      return { ok: false, status: response.status };
    }
    return {
      ok: true,
      status: response.status,
      body: await readJsonObject(response),
    };
  } catch (error: unknown) {
    if (error instanceof BridgeWriterError) throw error;
    throw new BridgeWriterError("transport_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBodyQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Best effort only. Error bodies are never included in logs/results.
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new BridgeWriterError("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BridgeWriterError("response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BridgeWriterError) throw error;
    throw new BridgeWriterError("response_read_failed");
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("invalid response");
    return parsed;
  } catch {
    throw new BridgeWriterError("invalid_json_response");
  }
}

async function login(
  fetcher: typeof fetch,
  baseUrl: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetchJsonBounded(fetcher, `${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!response.ok) {
    throw new BridgeWriterError(`auth_http_${response.status}`);
  }
  const body = response.body;
  if (!body) throw new BridgeWriterError("auth_invalid_response");
  if (typeof body.accessToken !== "string" || !body.accessToken || body.accessToken.includes("\0")) {
    throw new BridgeWriterError("auth_invalid_response");
  }
  return body.accessToken;
}

function secretQuery(): string {
  return new URLSearchParams({
    projectId: PROJECT_ID,
    environment: ENVIRONMENT,
    secretPath: SECRET_PATH,
    type: "shared",
    viewSecretValue: "true",
    expandSecretReferences: "false",
    includeImports: "false",
  }).toString();
}

function requireSecretIdentity(
  secret: Record<string, unknown>,
  secretName: string,
  requirePath: boolean
): void {
  if (
    secret.secretKey !== secretName ||
    secret.workspace !== PROJECT_ID ||
    secret.environment !== ENVIRONMENT ||
    secret.type !== "shared" ||
    (requirePath && secret.secretPath !== SECRET_PATH)
  ) {
    throw new BridgeWriterError("secret_scope_mismatch");
  }
}

async function listSecretNames(
  fetcher: typeof fetch,
  baseUrl: string,
  token: string
): Promise<Set<string>> {
  const query = new URLSearchParams({
    projectId: PROJECT_ID,
    environment: ENVIRONMENT,
    secretPath: SECRET_PATH,
    viewSecretValue: "false",
    expandSecretReferences: "false",
    recursive: "false",
    includePersonalOverrides: "false",
    includeImports: "false",
  });
  const response = await fetchJsonBounded(fetcher, `${baseUrl}/api/v4/secrets?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new BridgeWriterError(`scope_http_${response.status}`);
  }
  const body = response.body;
  if (!body) throw new BridgeWriterError("scope_invalid_response");
  if (!Array.isArray(body.secrets)) throw new BridgeWriterError("scope_invalid_response");
  const names = new Set<string>();
  for (const value of body.secrets) {
    if (!isRecord(value) || typeof value.secretKey !== "string") {
      throw new BridgeWriterError("scope_invalid_response");
    }
    requireSecretIdentity(value, value.secretKey, false);
    if (!ALLOWED_SECRET_NAMES.has(value.secretKey) || names.has(value.secretKey)) {
      throw new BridgeWriterError("scope_contains_unexpected_secret");
    }
    names.add(value.secretKey);
  }
  return names;
}

async function readSecret(
  fetcher: typeof fetch,
  baseUrl: string,
  token: string,
  secretName: string
): Promise<RemoteSecret> {
  const response = await fetchJsonBounded(
    fetcher,
    `${baseUrl}/api/v4/secrets/${encodeURIComponent(secretName)}?${secretQuery()}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (response.status === 404) {
    return { found: false };
  }
  if (!response.ok) {
    throw new BridgeWriterError(`secret_http_${response.status}`);
  }
  const body = response.body;
  if (!body) throw new BridgeWriterError("secret_invalid_response");
  if (!isRecord(body.secret)) throw new BridgeWriterError("secret_invalid_response");
  requireSecretIdentity(body.secret, secretName, true);
  if (typeof body.secret.secretValue !== "string") {
    throw new BridgeWriterError("secret_invalid_response");
  }
  if (Buffer.byteLength(body.secret.secretValue, "utf8") > MAX_SECRET_VALUE_BYTES) {
    throw new BridgeWriterError("secret_too_large");
  }
  return { found: true, value: body.secret.secretValue };
}

async function upsertSecret(
  fetcher: typeof fetch,
  baseUrl: string,
  token: string,
  secretName: string,
  secretValue: string,
  exists: boolean
): Promise<void> {
  const response = await fetchJsonBounded(
    fetcher,
    `${baseUrl}/api/v4/secrets/${encodeURIComponent(secretName)}`,
    {
      method: exists ? "PATCH" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        environment: ENVIRONMENT,
        secretPath: SECRET_PATH,
        type: "shared",
        secretValue,
      }),
    }
  );
  if (!response.ok) {
    throw new BridgeWriterError(`write_http_${response.status}`);
  }
  const body = response.body;
  if (!body) throw new BridgeWriterError("write_invalid_response");
  if (!isRecord(body.secret)) throw new BridgeWriterError("write_invalid_response");
  // v4 create/update responses omit secretPath. The exact GET proof below is
  // authoritative for the fixed path.
  requireSecretIdentity(body.secret, secretName, false);
  if (
    "secretValue" in body.secret &&
    (typeof body.secret.secretValue !== "string" ||
      !sameFingerprint(fingerprint(body.secret.secretValue), fingerprint(secretValue)))
  ) {
    throw new BridgeWriterError("write_value_mismatch");
  }

  const verified = await readSecret(fetcher, baseUrl, token, secretName);
  if (
    !verified.found ||
    !sameFingerprint(fingerprint(verified.value ?? ""), fingerprint(secretValue))
  ) {
    throw new BridgeWriterError("post_write_value_mismatch");
  }
}

function sameRemoteObservation(
  before: StPrimaryBridgeManifest | undefined,
  after: StPrimaryBridgeManifest | undefined
): boolean {
  if (!before || !after) return before === after;
  return before.sequence === after.sequence && sameFingerprint(manifestDigest(before), manifestDigest(after));
}

async function readRemoteManifest(
  fetcher: typeof fetch,
  baseUrl: string,
  token: string
): Promise<StPrimaryBridgeManifest | undefined> {
  const remote = await readSecret(fetcher, baseUrl, token, MANIFEST_SECRET);
  if (!remote.found) return undefined;
  return parseManifest(remote.value ?? "");
}

async function performSync(
  options: StPrimaryBridgeWriterOptions
): Promise<StPrimaryBridgeWriterResult> {
  const enabled = options.enabled ?? enabledValue(process.env[ENABLED_ENV]);
  if (!enabled) return { status: "disabled" };

  const clientId = clean(options.clientId ?? process.env[CLIENT_ID_ENV]);
  const clientSecret = clean(options.clientSecret ?? process.env[CLIENT_SECRET_ENV]);
  if (!clientId && !clientSecret) return { status: "unconfigured" };
  if (!clientId || !clientSecret) {
    return { status: "error", errorCode: "incomplete_writer_identity" };
  }

  const fetcher = options.fetcher ?? fetch;
  // Only tests can inject another origin; no environment variable can redirect
  // production credentials or primary-user keys away from Infisical Cloud.
  const baseUrl = options.baseUrl ?? BASE_URL;
  const desired = desiredEntries();
  const active = desired.filter((entry) => entry.status === "active").length;
  const revoked = desired.length - active;
  const published = readPublishedState();
  const token = await login(fetcher, baseUrl, clientId, clientSecret);
  const names = await listSecretNames(fetcher, baseUrl, token);
  const remoteManifest = names.has(MANIFEST_SECRET)
    ? await readRemoteManifest(fetcher, baseUrl, token)
    : undefined;
  if (names.has(MANIFEST_SECRET) && !remoteManifest) {
    throw new BridgeWriterError("manifest_missing_after_list");
  }

  if (
    published &&
    remoteManifest &&
    published.sequence === remoteManifest.sequence &&
    !sameFingerprint(published.manifestDigest, manifestDigest(remoteManifest))
  ) {
    throw new BridgeWriterError("manifest_sequence_conflict");
  }

  const values = new Map<string, RemoteSecret>();
  let remoteValuesCoherent = true;
  for (const entry of desired) {
    if (entry.status === "revoked") continue;
    const remote = await readSecret(fetcher, baseUrl, token, entry.secretName);
    values.set(entry.secretName, remote);
    if (
      !remote.found ||
      !sameFingerprint(fingerprint(remote.value ?? ""), entry.fingerprint ?? "")
    ) {
      remoteValuesCoherent = false;
    }
  }

  const contentMatches = remoteManifest
    ? sameFingerprint(
        manifestContentDigest(remoteManifest.entries),
        manifestContentDigest(desired)
      )
    : false;
  const remoteAtOrAhead = Boolean(
    remoteManifest && (!published || remoteManifest.sequence >= published.sequence)
  );
  if (contentMatches && remoteValuesCoherent && remoteAtOrAhead && remoteManifest) {
    setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_STATE_KEY, {
      schemaVersion: 1,
      sequence: remoteManifest.sequence,
      manifestDigest: manifestDigest(remoteManifest),
    } satisfies PublishedState);
    return { status: "unchanged", sequence: remoteManifest.sequence, active, revoked };
  }

  const baseSequence = Math.max(remoteManifest?.sequence ?? 0, published?.sequence ?? 0);
  if (!Number.isSafeInteger(baseSequence) || baseSequence >= Number.MAX_SAFE_INTEGER) {
    throw new BridgeWriterError("sequence_exhausted");
  }
  const nextManifest: StPrimaryBridgeManifest = {
    schemaVersion: 1,
    source: "socratic-trade-primary",
    complete: true,
    sequence: baseSequence + 1,
    entries: desired.map((entry) => ({
      id: entry.id,
      providerName: entry.providerName,
      capability: entry.capability,
      secretName: entry.secretName,
      status: entry.status,
      fingerprint: entry.fingerprint,
    })),
  };

  // Values are installed and individually verified first. Revocations are
  // manifest tombstones: the least-privilege writer intentionally has no
  // delete permission and the reader never fetches values marked revoked.
  for (const entry of desired) {
    if (entry.status !== "active") continue;
    const remote = values.get(entry.secretName) ?? { found: names.has(entry.secretName) };
    if (
      remote.found &&
      remote.value !== undefined &&
      sameFingerprint(fingerprint(remote.value), entry.fingerprint ?? "")
    ) {
      continue;
    }
    await upsertSecret(
      fetcher,
      baseUrl,
      token,
      entry.secretName,
      entry.value!,
      remote.found
    );
  }

  // Detect another writer between the initial read and commit. A mismatch
  // leaves the old manifest in place, so the monitor retains its last-known-good
  // complete set rather than accepting a mixed generation.
  const manifestBeforeCommit = await readRemoteManifest(fetcher, baseUrl, token);
  if (!sameRemoteObservation(remoteManifest, manifestBeforeCommit)) {
    throw new BridgeWriterError("concurrent_manifest_change");
  }

  const rawManifest = manifestString(nextManifest);
  await upsertSecret(
    fetcher,
    baseUrl,
    token,
    MANIFEST_SECRET,
    rawManifest,
    Boolean(manifestBeforeCommit)
  );
  const verifiedManifest = await readRemoteManifest(fetcher, baseUrl, token);
  if (
    !verifiedManifest ||
    verifiedManifest.sequence !== nextManifest.sequence ||
    !sameFingerprint(manifestDigest(verifiedManifest), manifestDigest(nextManifest))
  ) {
    throw new BridgeWriterError("post_write_manifest_mismatch");
  }

  // A second process can change values after our pre-commit fence without
  // changing the manifest. Never persist success unless the committed
  // generation and every active value are still coherent at final read-back.
  for (const entry of desired) {
    if (entry.status !== "active") continue;
    const verified = await readSecret(fetcher, baseUrl, token, entry.secretName);
    if (
      !verified.found ||
      !sameFingerprint(fingerprint(verified.value ?? ""), entry.fingerprint ?? "")
    ) {
      throw new BridgeWriterError("post_commit_value_mismatch");
    }
  }

  setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_STATE_KEY, {
    schemaVersion: 1,
    sequence: nextManifest.sequence,
    manifestDigest: manifestDigest(nextManifest),
  } satisfies PublishedState);
  return { status: "synced", sequence: nextManifest.sequence, active, revoked };
}

/** Publish the fixed primary-account complete set. Errors are sanitized to stable codes. */
export async function syncStPrimaryBridgeWriter(
  options: StPrimaryBridgeWriterOptions = {}
): Promise<StPrimaryBridgeWriterResult> {
  const requestedGeneration = options.force
    ? (inFlightHost.__stPrimaryBridgeWriterRequestedGeneration ?? 0) + 1
    : (inFlightHost.__stPrimaryBridgeWriterRequestedGeneration ?? 0);
  inFlightHost.__stPrimaryBridgeWriterRequestedGeneration = requestedGeneration;
  const existing = inFlightHost.__stPrimaryBridgeWriterInFlight;
  if (existing) {
    const result = await existing;
    if (
      options.force &&
      (inFlightHost.__stPrimaryBridgeWriterCompletedGeneration ?? 0) < requestedGeneration
    ) {
      // The force request landed after the current drain's final generation
      // check. Let its cleanup run, then start the missed generation.
      await Promise.resolve();
      return syncStPrimaryBridgeWriter({ ...options, force: false });
    }
    return result;
  }
  const run = (async () => {
    let result: StPrimaryBridgeWriterResult = { status: "error", errorCode: "sync_failed" };
    while (true) {
      const generation = inFlightHost.__stPrimaryBridgeWriterRequestedGeneration ?? 0;
      result = await performSync(options).catch((error: unknown) => ({
        status: "error" as const,
        errorCode: error instanceof BridgeWriterError ? error.code : "sync_failed",
      }));
      inFlightHost.__stPrimaryBridgeWriterCompletedGeneration = generation;
      if (generation === (inFlightHost.__stPrimaryBridgeWriterRequestedGeneration ?? 0)) {
        return result;
      }
    }
  })();
  inFlightHost.__stPrimaryBridgeWriterInFlight = run;
  try {
    return await run;
  } finally {
    if (inFlightHost.__stPrimaryBridgeWriterInFlight === run) {
      delete inFlightHost.__stPrimaryBridgeWriterInFlight;
    }
  }
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function intervalElapsedOrClockReset(
  now: number,
  marker: number | undefined,
  interval: number
): boolean {
  return marker === undefined || marker > now || now - marker >= interval;
}

/** Cadence-gated scheduler entrypoint; force is used only after a tracked key changes. */
export async function runStPrimaryBridgeWriterIfDue(
  options: StPrimaryBridgeWriterOptions = {}
): Promise<StPrimaryBridgeWriterResult> {
  if (!(options.enabled ?? enabledValue(process.env[ENABLED_ENV]))) {
    return { status: "disabled" };
  }
  try {
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now)) throw new BridgeWriterError("invalid_clock");
    const lastAttempt = timestampMs(
      getInternalSetting<unknown>(ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY)
    );
    const lastSuccess = timestampMs(
      getInternalSetting<unknown>(ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY)
    );
    const lastOutcome = getInternalSetting<unknown>(
      ST_PRIMARY_BRIDGE_WRITER_LAST_OUTCOME_KEY
    );
    if (lastOutcome !== undefined && lastOutcome !== "success" && lastOutcome !== "retry") {
      throw new BridgeWriterError("cadence_state_invalid");
    }
    const retryPending = lastOutcome === "retry";
    const due = options.force || (retryPending
      ? intervalElapsedOrClockReset(
        now,
        lastAttempt,
        ST_PRIMARY_BRIDGE_WRITER_RETRY_INTERVAL_MS
      )
      : intervalElapsedOrClockReset(
          now,
          lastSuccess,
          ST_PRIMARY_BRIDGE_WRITER_SUCCESS_INTERVAL_MS
        ) && intervalElapsedOrClockReset(
          now,
          lastAttempt,
          ST_PRIMARY_BRIDGE_WRITER_RETRY_INTERVAL_MS
        ));
    if (!due) return { status: "not_due" };

    setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY, new Date(now).toISOString());
    const result = await syncStPrimaryBridgeWriter(options);
    if (result.status === "synced" || result.status === "unchanged") {
      setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY, new Date(now).toISOString());
      setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_LAST_OUTCOME_KEY, "success");
    } else {
      setInternalSetting(ST_PRIMARY_BRIDGE_WRITER_LAST_OUTCOME_KEY, "retry");
    }
    return result;
  } catch (error: unknown) {
    return {
      status: "error",
      errorCode: error instanceof BridgeWriterError ? error.code : "cadence_failed",
    };
  }
}

/** Best-effort immediate sync after a primary Gemini/DeepSeek key mutation. */
export function queueStPrimaryBridgeWriterSync(): void {
  void runStPrimaryBridgeWriterIfDue({ force: true }).then((result) => {
    if (result.status === "error") {
      console.error(`[st-primary-bridge-writer] sync failed (${result.errorCode ?? "unknown"})`);
    }
  });
}

export function __resetStPrimaryBridgeWriterForTests(): void {
  delete inFlightHost.__stPrimaryBridgeWriterInFlight;
  delete inFlightHost.__stPrimaryBridgeWriterRequestedGeneration;
  delete inFlightHost.__stPrimaryBridgeWriterCompletedGeneration;
}
