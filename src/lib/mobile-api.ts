import crypto from "crypto";
import { createAlert, removeAlert } from "./alerts";
import { getBrokerGateway } from "./broker";
import {
  audit,
  getDataPoolConsent,
  getDb,
  getPolicy,
  getProposal,
  listConnectedAccounts,
  setActiveConnectedAccount,
  setDataPoolConsent,
  setPolicy
} from "./db";
import { isIndexUniverse, isValidAppSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import { notify } from "./notify";
import { DEFAULT_TAX_SETTINGS } from "./defaults";
import {
  executeProposal,
  LiveApprovalConfirmationError,
  rejectProposal,
  runStrategyOnce,
  type LiveApprovalConfirmation
} from "./strategy";
import { addToWatchlist, removeFromWatchlist } from "./watchlist";
import type {
  HoldingHorizon,
  IndexUniverse,
  NotificationEventType,
  RiskRules,
  StrategyAuthority,
  SystemState,
  TaxSettings,
  TradingPolicy
} from "./types";

export const MOBILE_COMMAND_TYPES = [
  "strategy.run_once",
  "strategy.start",
  "strategy.stop",
  "strategy.close_only",
  "strategy.liquidating",
  "proposal.approve",
  "proposal.reject",
  "account.activate",
  "watchlist.add",
  "watchlist.remove",
  "alert.create",
  "alert.delete",
  "policy.patch",
  "consent.set",
  "notification.test"
] as const;

export type MobileCommandType = (typeof MOBILE_COMMAND_TYPES)[number];
export type MobileCommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MobileClientInfo {
  platform?: "ios" | "web" | "unknown";
  appVersion?: string;
  buildNumber?: string;
  deviceIdHash?: string;
}

interface MobileCommandRecord {
  id: string;
  userId: string;
  idempotencyKey?: string;
  commandType: MobileCommandType;
  status: MobileCommandStatus;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  client?: MobileClientInfo;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface PublicMobileCommand {
  id: string;
  commandType: MobileCommandType;
  status: MobileCommandStatus;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  client?: MobileClientInfo;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface MobileCommandEvent {
  type: "mobile.command";
  userId: string;
  at: string;
  command: PublicMobileCommand;
}

type MobileListener = (event: MobileCommandEvent) => void;

const globalForMobileEvents = globalThis as unknown as {
  __mobileCommandListeners?: Set<MobileListener>;
  __mobileCommandWorkerInFlight?: boolean;
};
const mobileListeners =
  globalForMobileEvents.__mobileCommandListeners ??
  (globalForMobileEvents.__mobileCommandListeners = new Set<MobileListener>());

export class MobileCommandValidationError extends Error {
  status = 400;
}

export function isMobileCommandType(value: unknown): value is MobileCommandType {
  return typeof value === "string" && (MOBILE_COMMAND_TYPES as readonly string[]).includes(value);
}

export function subscribeMobileCommandEvents(listener: MobileListener): () => void {
  mobileListeners.add(listener);
  return () => {
    mobileListeners.delete(listener);
  };
}

function emitMobileCommandEvent(command: MobileCommandRecord): void {
  const event: MobileCommandEvent = {
    type: "mobile.command",
    userId: command.userId,
    at: new Date().toISOString(),
    command: toPublicMobileCommand(command)
  };
  for (const listener of mobileListeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber cannot break command execution.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asOptionalString(value: unknown, max = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeClientInfo(value: unknown): MobileClientInfo | undefined {
  const input = asRecord(value);
  const platformRaw = asOptionalString(input.platform, 32);
  const platform: MobileClientInfo["platform"] =
    platformRaw === "ios" || platformRaw === "web" ? platformRaw : platformRaw ? "unknown" : undefined;
  const appVersion = asOptionalString(input.appVersion, 64);
  const buildNumber = asOptionalString(input.buildNumber, 64);
  const deviceId = asOptionalString(input.deviceId, 256);
  const deviceIdHash = deviceId
    ? crypto.createHash("sha256").update(deviceId).digest("hex").slice(0, 24)
    : asOptionalString(input.deviceIdHash, 64);
  const client = { platform, appVersion, buildNumber, deviceIdHash };
  return Object.values(client).some(Boolean) ? client : undefined;
}

function parseJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  const key = asOptionalString(value, 128);
  return key && /^[A-Za-z0-9._:-]+$/.test(key) ? key : undefined;
}

function commandFromRow(row: Record<string, unknown>): MobileCommandRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
    commandType: String(row.command_type) as MobileCommandType,
    status: String(row.status) as MobileCommandStatus,
    payload: asRecord(parseJson(String(row.payload ?? "{}"), {})),
    result: parseJson(row.result == null ? undefined : String(row.result), undefined),
    error: row.error == null ? undefined : String(row.error),
    client: normalizeClientInfo(parseJson(row.client == null ? undefined : String(row.client), undefined)),
    createdAt: String(row.created_at),
    queuedAt: String(row.queued_at),
    startedAt: row.started_at == null ? undefined : String(row.started_at),
    finishedAt: row.finished_at == null ? undefined : String(row.finished_at),
    updatedAt: String(row.updated_at)
  };
}

function redactPayloadForResponse(commandType: MobileCommandType, payload: Record<string, unknown>): Record<string, unknown> {
  if (commandType === "proposal.approve") {
    return {
      proposalId: payload.proposalId,
      hasLiveConfirmation: typeof payload.liveConfirmation === "object" && payload.liveConfirmation !== null
    };
  }
  return payload;
}

export function toPublicMobileCommand(command: MobileCommandRecord): PublicMobileCommand {
  return {
    id: command.id,
    commandType: command.commandType,
    status: command.status,
    payload: redactPayloadForResponse(command.commandType, command.payload),
    result: command.result,
    error: command.error,
    client: command.client,
    createdAt: command.createdAt,
    queuedAt: command.queuedAt,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    updatedAt: command.updatedAt
  };
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = asOptionalString(payload[key]);
  if (!value) throw new MobileCommandValidationError(`${key} is required.`);
  return value;
}

function finiteNumber(value: unknown, key: string, opts: { min?: number; max?: number } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new MobileCommandValidationError(`${key} must be a number.`);
  if (opts.min !== undefined && n < opts.min) throw new MobileCommandValidationError(`${key} must be at least ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw new MobileCommandValidationError(`${key} must be at most ${opts.max}.`);
  return n;
}

function optionalFiniteNumber(value: unknown, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return finiteNumber(value, key, opts);
}

function normalizeSymbols(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new MobileCommandValidationError(`${key} must be an array.`);
  return Array.from(new Set(value.map(String).map(normalizeSymbol).filter(Boolean))).filter(isValidAppSymbol);
}

function normalizeNotificationEvents(value: unknown): NotificationEventType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed: NotificationEventType[] = ["fill", "block", "run_failed", "pending_approval", "kill_switch", "price_alert", "proposal_withdrawn"];
  return value.map(String).filter((item): item is NotificationEventType => allowed.includes(item as NotificationEventType));
}

function normalizePolicyPatch(raw: unknown): Partial<TradingPolicy> {
  const input = asRecord(raw);
  for (const forbidden of ["userId", "accountNumber", "connectedAccountId", "activeBroker", "apiKey", "apiSecret", "providerSecret"]) {
    if (forbidden in input) {
      throw new MobileCommandValidationError(`${forbidden} cannot be changed through policy.patch.`);
    }
  }

  const patch: Partial<TradingPolicy> = {};
  if (input.strategyAuthority !== undefined) {
    if (input.strategyAuthority !== "propose" && input.strategyAuthority !== "decide") {
      throw new MobileCommandValidationError("strategyAuthority must be propose or decide.");
    }
    patch.strategyAuthority = input.strategyAuthority as StrategyAuthority;
  }
  if (input.holdingHorizon !== undefined) {
    if (!["intraday", "swing", "position", "longterm"].includes(String(input.holdingHorizon))) {
      throw new MobileCommandValidationError("holdingHorizon is invalid.");
    }
    patch.holdingHorizon = input.holdingHorizon as HoldingHorizon;
  }
  if (input.includedIndices !== undefined) {
    if (!Array.isArray(input.includedIndices)) throw new MobileCommandValidationError("includedIndices must be an array.");
    patch.includedIndices = Array.from(new Set(input.includedIndices.map(String).filter(isIndexUniverse))) as IndexUniverse[];
  }
  if (input.additionalSymbols !== undefined) patch.additionalSymbols = normalizeSymbols(input.additionalSymbols, "additionalSymbols");
  if (input.blocklist !== undefined) patch.blocklist = normalizeSymbols(input.blocklist, "blocklist");

  const numericFields: Array<[keyof TradingPolicy, number | undefined, number | undefined]> = [
    ["maxOrderNotional", 1, 100_000],
    ["maxOrderPctOfNav", 0.01, 100],
    ["maxDailyNotional", 1, undefined],
    ["maxHourlyNotional", 1, undefined],
    ["maxDailyPctOfNav", 0.01, 100],
    ["maxSymbolExposurePct", 0.01, 100],
    ["maxSymbolExposureNotional", 1, undefined],
    ["maxGrossExposurePct", 0, 100],
    ["maxNetExposurePct", 0, 100],
    ["maxDailyOrders", 1, 500],
    ["maxProposalsPerRun", 1, 25],
    ["proposalExpiryMinutes", 0, undefined],
    ["proposalRevalidateCadenceHours", 0, undefined],
    ["runCadenceMinutes", 1, 24 * 60],
    ["maxShortOrderNotional", 1, 100_000],
    ["maxShortExposurePct", 0, 100],
    ["maxPortfolioBeta", 0.01, 10],
    ["maxEntryDriftPct", 0, 100],
    ["maxOrderPctOfAdv", 0, 100],
    ["volPanicVixThreshold", 0, undefined],
    ["volPanicVvixThreshold", 0, undefined],
    ["volPanicSkewThreshold", 0, undefined]
  ];
  for (const [field, min, max] of numericFields) {
    if (input[field] !== undefined) {
      (patch as Record<string, unknown>)[field] = finiteNumber(input[field], String(field), { min, max });
    }
  }

  for (const field of [
    "permitExtendedHours",
    "runDuringExtendedHours",
    "allowExtendedHoursSyntheticStops",
    "shortSellingEnabled",
    "brokerBracketsEnabled",
    "betaScaledStops",
    "marketableLimitEntries",
    "volPanicBrakeEnabled"
  ] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== "boolean") throw new MobileCommandValidationError(`${field} must be boolean.`);
      patch[field] = input[field] as never;
    }
  }

  if (input.riskRules !== undefined) {
    const risk = asRecord(input.riskRules);
    const next: Partial<RiskRules> = {};
    for (const [key, value] of Object.entries(risk)) {
      if (!["stopLossPct", "stopLossNotional", "takeProfitPct", "takeProfitNotional", "trailingStopPct", "shortStopLossPct", "maxDrawdownPct", "maxDailyLossNotional"].includes(key)) continue;
      (next as Record<string, number>)[key] = finiteNumber(value, `riskRules.${key}`, { min: 0 });
    }
    patch.riskRules = next;
  }

  if (input.notificationSettings !== undefined) {
    const settings = asRecord(input.notificationSettings);
    const next: Partial<TradingPolicy["notificationSettings"]> = {};
    if (settings.webhookUrl !== undefined) {
      const webhookUrl = asOptionalString(settings.webhookUrl, 2048) ?? "";
      if (webhookUrl) new URL(webhookUrl);
      next.webhookUrl = webhookUrl;
    }
    const enabledEvents = normalizeNotificationEvents(settings.enabledEvents);
    if (enabledEvents) next.enabledEvents = enabledEvents;
    patch.notificationSettings = next as TradingPolicy["notificationSettings"];
  }

  if (input.taxSettings !== undefined) {
    const tax = asRecord(input.taxSettings);
    const next: Partial<TaxSettings> = {};
    if (tax.taxationType !== undefined) {
      if (!["taxable", "roth_ira", "traditional_ira"].includes(String(tax.taxationType))) {
        throw new MobileCommandValidationError("taxSettings.taxationType is invalid.");
      }
      next.taxationType = tax.taxationType as TaxSettings["taxationType"];
    }
    if (tax.washSaleGuard !== undefined) {
      if (typeof tax.washSaleGuard !== "boolean") throw new MobileCommandValidationError("taxSettings.washSaleGuard must be boolean.");
      next.washSaleGuard = tax.washSaleGuard;
    }
    const shortTermRatePct = optionalFiniteNumber(tax.shortTermRatePct, "taxSettings.shortTermRatePct", { min: 0, max: 100 });
    const longTermRatePct = optionalFiniteNumber(tax.longTermRatePct, "taxSettings.longTermRatePct", { min: 0, max: 100 });
    if (shortTermRatePct !== undefined) next.shortTermRatePct = shortTermRatePct;
    if (longTermRatePct !== undefined) next.longTermRatePct = longTermRatePct;
    if (tax.subtractFromResults !== undefined) {
      if (typeof tax.subtractFromResults !== "boolean") throw new MobileCommandValidationError("taxSettings.subtractFromResults must be boolean.");
      next.subtractFromResults = tax.subtractFromResults;
    }
    patch.taxSettings = next as TaxSettings;
  }

  if (Object.keys(patch).length === 0) throw new MobileCommandValidationError("policy.patch has no allowed fields.");
  return patch;
}

function normalizeCommandPayload(commandType: MobileCommandType, rawPayload: unknown): Record<string, unknown> {
  const payload = asRecord(rawPayload);
  switch (commandType) {
    case "strategy.run_once":
    case "strategy.start":
    case "strategy.stop":
    case "strategy.close_only":
    case "strategy.liquidating":
    case "notification.test":
      return {};
    case "proposal.approve": {
      const proposalId = requireString(payload, "proposalId");
      const liveConfirmation = asRecord(payload.liveConfirmation);
      return Object.keys(liveConfirmation).length > 0 ? { proposalId, liveConfirmation } : { proposalId };
    }
    case "proposal.reject":
      return { proposalId: requireString(payload, "proposalId") };
    case "account.activate":
      return { accountId: requireString(payload, "accountId") };
    case "watchlist.add":
    case "watchlist.remove": {
      const symbol = normalizeSymbol(requireString(payload, "symbol"));
      if (!isValidAppSymbol(symbol)) throw new MobileCommandValidationError(`${symbol} is not supported by the equity universe.`);
      return { symbol };
    }
    case "alert.create": {
      const symbol = normalizeSymbol(requireString(payload, "symbol"));
      const op = requireString(payload, "op");
      const price = finiteNumber(payload.price, "price", { min: 0.01 });
      const note = asOptionalString(payload.note, 500);
      return { symbol, op, price, ...(note ? { note } : {}) };
    }
    case "alert.delete":
      return { alertId: requireString(payload, "alertId") };
    case "policy.patch":
      return { patch: normalizePolicyPatch(payload.patch ?? payload) };
    case "consent.set":
      if (typeof payload.accepted !== "boolean") throw new MobileCommandValidationError("accepted must be boolean.");
      return { accepted: payload.accepted };
  }
}

export function queueMobileCommand(input: {
  userId: string;
  commandType: MobileCommandType;
  payload?: unknown;
  idempotencyKey?: unknown;
  client?: unknown;
  now?: Date;
}): { command: PublicMobileCommand; deduped: boolean } {
  const payload = normalizeCommandPayload(input.commandType, input.payload);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const client = normalizeClientInfo(input.client);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const database = getDb();
  const create = database.transaction(() => {
    if (idempotencyKey) {
      const existing = database
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? AND idempotency_key = ?")
        .get(input.userId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { record: commandFromRow(existing), deduped: true };
    }

    const id = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO mobile_commands
          (id, user_id, idempotency_key, command_type, status, payload, result, error, client, created_at, queued_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.userId,
        idempotencyKey ?? null,
        input.commandType,
        JSON.stringify(payload),
        client ? JSON.stringify(client) : null,
        nowIso,
        nowIso,
        nowIso
      );
    const row = database.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown>;
    return { record: commandFromRow(row), deduped: false };
  });

  const { record, deduped } = create() as { record: MobileCommandRecord; deduped: boolean };
  if (!deduped) {
    audit(
      "mobile_command_queued",
      {
        commandId: record.id,
        commandType: record.commandType,
        hasIdempotencyKey: Boolean(record.idempotencyKey),
        payload: redactPayloadForResponse(record.commandType, record.payload),
        client: record.client
      },
      input.userId
    );
    emitMobileCommandEvent(record);
  }
  return { command: toPublicMobileCommand(record), deduped };
}

export function getMobileCommand(id: string, userId: string): PublicMobileCommand | undefined {
  const row = getDb()
    .prepare("SELECT * FROM mobile_commands WHERE id = ? AND user_id = ?")
    .get(id, userId) as Record<string, unknown> | undefined;
  return row ? toPublicMobileCommand(commandFromRow(row)) : undefined;
}

function getMobileCommandRecord(id: string, userId?: string): MobileCommandRecord | undefined {
  const row = userId
    ? (getDb().prepare("SELECT * FROM mobile_commands WHERE id = ? AND user_id = ?").get(id, userId) as Record<string, unknown> | undefined)
    : (getDb().prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined);
  return row ? commandFromRow(row) : undefined;
}

export function listMobileCommands(input: {
  userId: string;
  status?: MobileCommandStatus;
  limit?: number;
}): PublicMobileCommand[] {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const rows = input.status
    ? (getDb()
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?")
        .all(input.userId, input.status, limit) as Record<string, unknown>[])
    : (getDb()
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(input.userId, limit) as Record<string, unknown>[]);
  return rows.map(commandFromRow).map(toPublicMobileCommand);
}

function claimNextQueuedCommand(): MobileCommandRecord | undefined {
  const database = getDb();
  const nowIso = new Date().toISOString();
  const claim = database.transaction(() => {
    const row = database
      .prepare("SELECT * FROM mobile_commands WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const id = String(row.id);
    const info = database
      .prepare("UPDATE mobile_commands SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso, nowIso, id);
    if (info.changes !== 1) return undefined;
    return commandFromRow(database.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown>);
  });
  return claim() as MobileCommandRecord | undefined;
}

function finishCommand(command: MobileCommandRecord, status: "succeeded" | "failed", result: unknown, error?: string): MobileCommandRecord {
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE mobile_commands SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ?"
    )
    .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, nowIso, nowIso, command.id, command.userId);
  const updated = getMobileCommandRecord(command.id, command.userId)!;
  audit(
    status === "succeeded" ? "mobile_command_succeeded" : "mobile_command_failed",
    {
      commandId: command.id,
      commandType: command.commandType,
      error,
      result: status === "succeeded" ? summarizeResult(result) : undefined
    },
    command.userId
  );
  emitMobileCommandEvent(updated);
  return updated;
}

function summarizeResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  return {
    ok: obj.ok,
    status: obj.status,
    runId: obj.runId,
    proposalId: obj.proposalId,
    orderId: obj.orderId,
    removed: obj.removed,
    symbol: obj.symbol
  };
}

async function setStrategyState(userId: string, state: SystemState): Promise<{ ok: true; systemState: SystemState }> {
  const policy = getPolicy(userId);
  if (state !== "halted") {
    if (!policy.accountNumber) throw new Error("Select an account before changing strategy state.");
    if (policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) {
      throw new Error("Select at least one base index or additional watchlist symbol before changing strategy state.");
    }
  }
  if (state === "active") {
    const account = (await getBrokerGateway(policy, userId).getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
    if (!account) throw new Error("Selected account is not available.");
    if (!account.agenticAllowed) throw new Error("Selected account is not agentic_allowed.");
  }
  const next = { ...policy, systemState: state } as TradingPolicy & { enabled?: boolean };
  if (state === "halted") next.enabled = false;
  setPolicy(next, userId);
  audit("mobile_strategy_state", { from: policy.systemState, to: state }, userId);
  return { ok: true, systemState: state };
}

function applyPolicyPatch(userId: string, patch: Partial<TradingPolicy>): { ok: true; policy: TradingPolicy } {
  const current = getPolicy(userId);
  const next: TradingPolicy = {
    ...current,
    ...patch,
    riskRules: { ...current.riskRules, ...(patch.riskRules ?? {}) },
    notificationSettings: {
      ...current.notificationSettings,
      ...(patch.notificationSettings ?? {}),
      enabledEvents: patch.notificationSettings?.enabledEvents ?? current.notificationSettings.enabledEvents
    },
    taxSettings: { ...DEFAULT_TAX_SETTINGS, ...(current.taxSettings ?? {}), ...(patch.taxSettings ?? {}) },
    tuning: { ...(current.tuning ?? {}), ...(patch.tuning ?? {}) }
  };
  if (next.systemState === "active") {
    if (!next.accountNumber) throw new Error("Select an account before enabling autonomy.");
    if (next.includedIndices.length === 0 && next.additionalSymbols.length === 0) {
      throw new Error("Select at least one base index or additional watchlist symbol before enabling autonomy.");
    }
  }
  setPolicy(next, userId);
  audit("mobile_policy_patch", { fields: Object.keys(patch) }, userId);
  return { ok: true, policy: getPolicy(userId) };
}

async function runCommand(command: MobileCommandRecord): Promise<unknown> {
  const payload = command.payload;
  switch (command.commandType) {
    case "strategy.run_once": {
      const result = await runStrategyOnce(command.userId, { manual: true });
      if (result.status === "failed") throw new Error(result.summary || "Strategy run failed.");
      return result;
    }
    case "strategy.start":
      return setStrategyState(command.userId, "active");
    case "strategy.stop":
      return setStrategyState(command.userId, "halted");
    case "strategy.close_only":
      return setStrategyState(command.userId, "close_only");
    case "strategy.liquidating":
      return setStrategyState(command.userId, "liquidating");
    case "proposal.approve":
      return executeProposal(String(payload.proposalId), command.userId, {
        liveConfirmation: payload.liveConfirmation as LiveApprovalConfirmation | undefined
      });
    case "proposal.reject": {
      const proposalId = String(payload.proposalId);
      if (!getProposal(proposalId, command.userId)) throw new Error("Proposal not found.");
      rejectProposal(proposalId, command.userId);
      return { ok: true, status: "rejected", proposalId };
    }
    case "account.activate": {
      const accountId = String(payload.accountId);
      setActiveConnectedAccount(accountId, command.userId);
      audit("mobile_account_activate", { accountId }, command.userId);
      return { ok: true, activeAccount: listConnectedAccounts(command.userId).find((account) => account.id === accountId) };
    }
    case "watchlist.add": {
      const item = addToWatchlist(command.userId, String(payload.symbol));
      return { ok: true, ...item };
    }
    case "watchlist.remove": {
      const symbol = String(payload.symbol);
      return { ok: true, symbol, removed: removeFromWatchlist(command.userId, symbol) };
    }
    case "alert.create": {
      const result = createAlert(command.userId, {
        symbol: String(payload.symbol),
        op: String(payload.op),
        price: Number(payload.price),
        note: typeof payload.note === "string" ? payload.note : undefined
      });
      if ("error" in result) throw new Error(result.error);
      return { ok: true, alert: result };
    }
    case "alert.delete": {
      const alertId = String(payload.alertId);
      return { ok: true, alertId, removed: removeAlert(command.userId, alertId) };
    }
    case "policy.patch":
      return applyPolicyPatch(command.userId, payload.patch as Partial<TradingPolicy>);
    case "consent.set":
      return { ok: true, consent: setDataPoolConsent(command.userId, payload.accepted === true) };
    case "notification.test":
      return {
        ok: true,
        results: await notify(command.userId, {
          title: "Test notification",
          body: "If you received this, your iPhone alert path is working.",
          kind: "test"
        })
      };
  }
}

function errorPayload(error: unknown): { message: string; result?: unknown } {
  if (error instanceof LiveApprovalConfirmationError) {
    return {
      message: error.message,
      result: { error: error.code, reasons: error.reasons, expectedText: error.expectedText }
    };
  }
  return { message: error instanceof Error ? error.message : "Mobile command failed." };
}

export async function executeMobileCommand(command: MobileCommandRecord): Promise<PublicMobileCommand> {
  try {
    const result = await runCommand(command);
    return toPublicMobileCommand(finishCommand(command, "succeeded", result));
  } catch (error) {
    const payload = errorPayload(error);
    return toPublicMobileCommand(finishCommand(command, "failed", payload.result, payload.message));
  }
}

export async function processPendingMobileCommands(options: { limit?: number } = {}): Promise<{ processed: number }> {
  if (globalForMobileEvents.__mobileCommandWorkerInFlight) return { processed: 0 };
  globalForMobileEvents.__mobileCommandWorkerInFlight = true;
  let processed = 0;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 3), 1), 10);
  try {
    while (processed < limit) {
      const command = claimNextQueuedCommand();
      if (!command) break;
      emitMobileCommandEvent(command);
      await executeMobileCommand(command);
      processed += 1;
    }
    return { processed };
  } finally {
    globalForMobileEvents.__mobileCommandWorkerInFlight = false;
  }
}

export function mobileCommandBacklog(): { queued: number; running: number } {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM mobile_commands WHERE status IN ('queued','running') GROUP BY status")
    .all() as Array<{ status: MobileCommandStatus; n: number }>;
  return {
    queued: rows.find((row) => row.status === "queued")?.n ?? 0,
    running: rows.find((row) => row.status === "running")?.n ?? 0
  };
}

export function mobileControlCatalog() {
  return {
    version: 1,
    auth: {
      mode: "server-session",
      supported: ["Cloudflare Access", "Auth.js session"],
      phoneStores: "session token only; provider and broker secrets stay server-side"
    },
    realtime: {
      sse: "/api/mobile/events",
      eventTypes: ["mobile.command", "dashboard.run-complete", "dashboard.proposal", "dashboard.order", "dashboard.market-data", "dashboard.dirty"]
    },
    accountDeletion: {
      request: "POST /api/mobile/account-deletion/request",
      confirm: "POST /api/mobile/account-deletion/confirm",
      requiredText: "DELETE MY ACCOUNT",
      note: "Deletes app-side data and server-stored secrets for the signed-in OAuth identity, then the client should sign out."
    },
    commands: MOBILE_COMMAND_TYPES.map((type) => ({ type }))
  };
}

export function mobileReadiness(userId: string) {
  const policy = getPolicy(userId);
  const consent = getDataPoolConsent(userId);
  const connectedAccounts = listConnectedAccounts(userId);
  return {
    hasAccount: Boolean(policy.accountNumber),
    hasUniverse: policy.includedIndices.length > 0 || policy.additionalSymbols.length > 0,
    systemState: policy.systemState,
    strategyAuthority: policy.strategyAuthority,
    selectedAccountNumber: policy.accountNumber ?? null,
    activeConnectedAccount: connectedAccounts.find((account) => account.isActive) ?? null,
    dataPoolConsent: consent,
    commandBacklog: mobileCommandBacklog()
  };
}
