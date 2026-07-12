import { decryptValue, deleteInternalSetting, encryptValue, findInternalSettingByKeyLike, getDb, getInternalSetting, setInternalSetting } from "./db";
import { isLoopbackUrl, resolvePublicAppOrigin } from "./public-origin";
export { resolvePublicAppOrigin } from "./public-origin";

// CLIENT registration is global (one OAuth app client shared across users).
const CLIENT_SETTING = "robinhood_mcp_oauth_client";
export const ROBINHOOD_MCP_CALLBACK_PATH = "/api/auth/robinhood/callback";
const LOCAL_DEFAULT_REDIRECT_URI = `http://localhost:3000${ROBINHOOD_MCP_CALLBACK_PATH}`;
const DEFAULT_ROBINHOOD_MCP_RESOURCE = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";

// Per-user key builders.  The state key embeds the random part last so LIKE
// queries can scan by prefix without exposing userId in the OAuth redirect URL.
//   token:  robinhood_mcp_oauth_token:<userId>
//   state:  robinhood_mcp_oauth_state:<userId>:<randomPart>
function tokenSettingKey(userId: string): string {
  return `robinhood_mcp_oauth_token:${userId}`;
}
function stateSettingKey(userId: string, randomPart: string): string {
  return `robinhood_mcp_oauth_state:${userId}:${randomPart}`;
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post";
  redirectUri?: string;
}

export interface McpOAuthState {
  state: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: string;
}

export interface McpOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  redirectUri: string;
  resource?: string;
  scope: string;
  clientName: string;
}

export interface McpOAuthConfigOptions {
  redirectUri?: string;
}

export interface BuildMcpAuthorizationUrlOptions {
  redirectUri?: string;
}

interface OAuthProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

interface OAuthAuthorizationServerMetadata {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  scopes_supported?: unknown;
}

export function getMcpOAuthConfig(options: McpOAuthConfigOptions = {}): McpOAuthConfig | undefined {
  const authorizationUrl = process.env.ROBINHOOD_MCP_AUTHORIZATION_URL;
  const tokenUrl = process.env.ROBINHOOD_MCP_TOKEN_URL;
  if (!authorizationUrl || !tokenUrl) return undefined;
  return {
    authorizationUrl,
    tokenUrl,
    registrationUrl: process.env.ROBINHOOD_MCP_CLIENT_REGISTRATION_URL || undefined,
    redirectUri: options.redirectUri || process.env.ROBINHOOD_MCP_REDIRECT_URI || LOCAL_DEFAULT_REDIRECT_URI,
    resource: process.env.ROBINHOOD_MCP_RESOURCE || process.env.ROBINHOOD_MCP_URL || DEFAULT_ROBINHOOD_MCP_RESOURCE,
    scope: process.env.ROBINHOOD_MCP_SCOPES || "tools:call",
    clientName: process.env.ROBINHOOD_MCP_CLIENT_NAME || "Socratic Trade"
  };
}

export function resolveMcpOAuthRedirectUri(request: Request): string {
  const configured = process.env.ROBINHOOD_MCP_REDIRECT_URI?.trim();
  const requestRedirectUri = new URL(ROBINHOOD_MCP_CALLBACK_PATH, resolvePublicAppOrigin(request)).toString();
  if (!configured) return requestRedirectUri;
  if (isLoopbackUrl(configured) && !isLoopbackUrl(requestRedirectUri) && !allowConfiguredLoopbackRedirect()) return requestRedirectUri;
  return configured;
}

function allowConfiguredLoopbackRedirect(): boolean {
  const value = process.env.ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export async function buildMcpAuthorizationUrl(userId: string, options: BuildMcpAuthorizationUrlOptions = {}): Promise<string> {
  const config = await requireOAuthConfig(options);
  const client = await getOrRegisterClient(config);
  const randomPart = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  setInternalSetting(stateSettingKey(userId, randomPart), {
    state: randomPart,
    userId,
    codeVerifier,
    redirectUri: config.redirectUri,
    createdAt: new Date().toISOString()
  } satisfies McpOAuthState);

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", randomPart);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.resource) url.searchParams.set("resource", config.resource);
  return url.toString();
}

/**
 * Recover a stored McpOAuthState by scanning for a settings row whose key
 * matches `robinhood_mcp_oauth_state:%:<randomPart>`.  The callback route
 * receives only `state` (the random part) with no session context, so we
 * scan by the random suffix which has 32 bytes of entropy.
 */
export function findMcpOAuthStateByRandom(randomPart: string): { key: string; value: McpOAuthState } | undefined {
  return findInternalSettingByKeyLike<McpOAuthState>(`robinhood_mcp_oauth_state:%:${randomPart}`);
}

export async function completeMcpOAuthCallback(input: {
  code: string;
  state: string;
  /**
   * The userId resolved from the browser session that hit the callback. When provided, it
   * must match the userId the flow was initiated under (`stateBlob.userId`). This stops an
   * attacker-initiated flow (state bound to the attacker) from being completed in a victim's
   * session — i.e. binding a freshly-minted broker token under the wrong userId. OAuth
   * provider callbacks may arrive without app-session identity, so callers can omit this
   * and bind by the one-time server-side state row alone.
   */
  expectedUserId?: string;
}): Promise<McpOAuthTokens> {
  // Recover the state blob by scanning on the random suffix — the redirect carries only the
  // random `state`, not the userId (the userId is never placed in the OAuth redirect URL).
  const found = findMcpOAuthStateByRandom(input.state);
  if (!found) throw new Error("Robinhood MCP OAuth state was not found or already used.");
  const { key: stateKey, value: stateBlob } = found;
  deleteInternalSetting(stateKey);

  // Cross-check the completing session against the initiating session. The state row is
  // consumed above regardless, so a mismatched attempt can't be retried with the same state.
  if (input.expectedUserId !== undefined && input.expectedUserId !== stateBlob.userId) {
    throw new Error("Robinhood MCP OAuth state does not belong to the current session.");
  }

  const config = await requireOAuthConfig({ redirectUri: stateBlob.redirectUri });
  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: stateBlob.redirectUri,
    client_id: client.clientId,
    code_verifier: stateBlob.codeVerifier
  });
  if (config.resource) body.set("resource", config.resource);
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const tokens = await exchangeToken(config.tokenUrl, body);
  setMcpOAuthTokens(stateBlob.userId, tokens);
  return tokens;
}

/**
 * Get the access token for a specific user — always from that user's own stored OAuth token.
 *
 * There is no env-token special case: the legacy `ROBINHOOD_MCP_AUTH_TOKEN` env override is
 * migrated into the `local` operator's stored token at boot (migrateLocalRobinhoodToken), so the
 * primary user resolves it like any other user and a non-`local` tenant can never reach it.
 */
export async function getMcpAccessToken(userId: string): Promise<string | undefined> {
  const tokens = getStoredMcpOAuthTokens(userId);
  if (!tokens) return undefined;
  if (!isExpiring(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken;
  return refreshMcpAccessToken(userId, tokens);
}

/**
 * Boot migration: seed the `local` operator's stored OAuth token from the legacy
 * `ROBINHOOD_MCP_AUTH_TOKEN` env override, so broker-token resolution is uniformly per-user (no
 * special env branch). Idempotent — only seeds when `local` has no stored token yet.
 */
export function migrateLocalRobinhoodToken(): boolean {
  const env = process.env.ROBINHOOD_MCP_AUTH_TOKEN?.trim();
  if (!env) return false;
  if (getStoredMcpOAuthTokens("local")) return false;
  setMcpOAuthTokens("local", { accessToken: env, tokenType: "Bearer" });
  return true;
}

/**
 * Encrypt-on-write / decrypt-on-read helpers for the Robinhood OAuth token blob. Only the SECRET
 * fields (`accessToken`, `refreshToken`) are run through the shared AES-256-GCM field encryption
 * (encryptValue/decryptValue from db-api-keys) — the non-secret metadata (tokenType/scope/expiresAt)
 * stays plaintext for debuggability. `decryptValue` tolerates legacy plaintext (its 3-part
 * `iv:tag:ct` check returns non-envelope values unchanged), so tokens stored before this change still
 * load without a migration.
 *
 * Encryption is applied ONLY when a stable `ENCRYPTION_KEY` is configured. Without it, db-api-keys
 * falls back to a random in-memory key that is lost on restart — encrypting with it would give no
 * real at-rest protection AND silently brick a token after the next restart (it would decrypt to
 * garbage). So when no key is set we keep the tokens as plaintext, exactly as before this change:
 * encryption is a strict upgrade for deployments that set `ENCRYPTION_KEY`, never a regression for
 * those that don't.
 */
function encryptionKeyConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY);
}

function encryptStoredTokens(tokens: McpOAuthTokens): McpOAuthTokens {
  if (!encryptionKeyConfigured()) return tokens; // no stable key → store plaintext (survives restart)
  return {
    ...tokens,
    accessToken: tokens.accessToken ? encryptValue(tokens.accessToken) : tokens.accessToken,
    refreshToken: tokens.refreshToken ? encryptValue(tokens.refreshToken) : tokens.refreshToken
  };
}

function decryptStoredTokens(tokens: McpOAuthTokens): McpOAuthTokens {
  return {
    ...tokens,
    accessToken: tokens.accessToken ? decryptValue(tokens.accessToken) : tokens.accessToken,
    refreshToken: tokens.refreshToken ? decryptValue(tokens.refreshToken) : tokens.refreshToken
  };
}

export function getStoredMcpOAuthTokens(userId: string): McpOAuthTokens | undefined {
  const stored = getInternalSetting<McpOAuthTokens>(tokenSettingKey(userId));
  if (!stored) return undefined;
  const decrypted = decryptStoredTokens(stored);
  // A stored token always has a non-empty accessToken. An empty one here means decryption FAILED
  // (e.g. a row encrypted under a since-lost ephemeral key). Treat it as MISSING so the env-token
  // migration / OAuth re-auth path runs instead of surfacing a dead token as if it were valid.
  if (!decrypted.accessToken) return undefined;
  return decrypted;
}

export function clearMcpOAuthTokens(userId: string): void {
  deleteInternalSetting(tokenSettingKey(userId));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function clearMcpOAuthForUser(userId: string): { tokenDeleted: number; stateDeleted: number } {
  const db = getDb();
  const tokenDeleted = db.prepare("DELETE FROM settings WHERE key = ?").run(tokenSettingKey(userId)).changes;
  const stateDeleted = db
    .prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .run(`robinhood_mcp_oauth_state:${escapeLike(userId)}:%`).changes;
  return { tokenDeleted, stateDeleted };
}

export function setMcpOAuthTokens(userId: string, tokens: McpOAuthTokens): void {
  // Encrypt the secret fields at rest so a settings-row leak (backup, replica, casual DB read)
  // never exposes a live Robinhood bearer/refresh token in plaintext.
  setInternalSetting(tokenSettingKey(userId), encryptStoredTokens(tokens));
}

export function tokenResponseToTokens(raw: Record<string, unknown>, existing?: McpOAuthTokens): McpOAuthTokens {
  const accessToken = String(raw.access_token ?? "");
  if (!accessToken) throw new Error("Robinhood MCP OAuth token response did not include an access token.");
  const expiresIn = Number(raw.expires_in);
  return {
    accessToken,
    refreshToken: raw.refresh_token ? String(raw.refresh_token) : existing?.refreshToken,
    tokenType: String(raw.token_type ?? existing?.tokenType ?? "Bearer"),
    scope: raw.scope ? String(raw.scope) : existing?.scope,
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
  };
}

async function refreshMcpAccessToken(userId: string, existing: McpOAuthTokens): Promise<string> {
  const config = await requireOAuthConfig();
  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken ?? "",
    client_id: client.clientId
  });
  if (config.resource) body.set("resource", config.resource);
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const tokens = await exchangeToken(config.tokenUrl, body, existing);
  setMcpOAuthTokens(userId, tokens);
  return tokens.accessToken;
}

async function getOrRegisterClient(config: McpOAuthConfig): Promise<McpOAuthClient> {
  const existing = getInternalSetting<McpOAuthClient>(CLIENT_SETTING);
  if (config.registrationUrl) {
    if (existing && existing.redirectUri === config.redirectUri) return existing;
  } else {
    if (existing) return existing;
    const configuredClientId = process.env.ROBINHOOD_MCP_CLIENT_ID;
    if (configuredClientId) {
      return {
        clientId: configuredClientId,
        clientSecret: process.env.ROBINHOOD_MCP_CLIENT_SECRET || undefined,
        tokenEndpointAuthMethod: process.env.ROBINHOOD_MCP_CLIENT_SECRET ? "client_secret_post" : "none"
      };
    }
    throw new Error("ROBINHOOD_MCP_CLIENT_ID or ROBINHOOD_MCP_CLIENT_REGISTRATION_URL is required for MCP OAuth.");
  }

  const response = await fetch(config.registrationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: config.clientName,
      redirect_uris: [config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  if (!response.ok) throw new Error(`Robinhood MCP OAuth registration failed with HTTP ${response.status}.`);
  const raw = (await response.json()) as Record<string, unknown>;
  const client: McpOAuthClient = {
    clientId: String(raw.client_id ?? ""),
    clientSecret: raw.client_secret ? String(raw.client_secret) : undefined,
    tokenEndpointAuthMethod: raw.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none",
    redirectUri: config.redirectUri
  };
  if (!client.clientId) throw new Error("Robinhood MCP OAuth registration did not return a client_id.");
  setInternalSetting(CLIENT_SETTING, client);
  return client;
}

async function exchangeToken(tokenUrl: string, body: URLSearchParams, existing?: McpOAuthTokens): Promise<McpOAuthTokens> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Robinhood MCP OAuth token exchange failed with HTTP ${response.status}.`);
  return tokenResponseToTokens((await response.json()) as Record<string, unknown>, existing);
}

function isExpiring(tokens: McpOAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return new Date(tokens.expiresAt).getTime() - Date.now() < 60_000;
}

async function requireOAuthConfig(options: McpOAuthConfigOptions = {}): Promise<McpOAuthConfig> {
  const configured = getMcpOAuthConfig(options);
  if (shouldDiscoverOAuthConfig()) {
    try {
      return await discoverMcpOAuthConfig(options);
    } catch (error) {
      if (isOAuthDiscoveryRequired()) throw error;
    }
  }
  const config = configured;
  if (!config) {
    throw new Error(
      "Robinhood MCP OAuth discovery failed and ROBINHOOD_MCP_AUTHORIZATION_URL / ROBINHOOD_MCP_TOKEN_URL are not configured."
    );
  }
  return config;
}

function shouldDiscoverOAuthConfig(): boolean {
  const mode = normalizedDiscoveryMode();
  if (mode === "off" || mode === "false" || mode === "0") return false;
  if (mode === "on" || mode === "true" || mode === "1" || mode === "required") return true;

  const hasManualEndpoints = Boolean(process.env.ROBINHOOD_MCP_AUTHORIZATION_URL && process.env.ROBINHOOD_MCP_TOKEN_URL);
  const configuredMcpUrl = process.env.ROBINHOOD_MCP_URL?.trim();
  return !hasManualEndpoints || Boolean(configuredMcpUrl && isOfficialRobinhoodMcpUrl(configuredMcpUrl));
}

function isOAuthDiscoveryRequired(): boolean {
  return normalizedDiscoveryMode() === "required";
}

function normalizedDiscoveryMode(): string | undefined {
  return process.env.ROBINHOOD_MCP_OAUTH_DISCOVERY?.trim().toLowerCase();
}

function isOfficialRobinhoodMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://agent.robinhood.com" && url.pathname === "/mcp/trading";
  } catch {
    return false;
  }
}

async function discoverMcpOAuthConfig(options: McpOAuthConfigOptions = {}): Promise<McpOAuthConfig> {
  const mcpUrl = process.env.ROBINHOOD_MCP_URL || DEFAULT_ROBINHOOD_MCP_RESOURCE;
  const metadataUrl = await discoverProtectedResourceMetadataUrl(mcpUrl);
  const protectedResource = await fetchJson<OAuthProtectedResourceMetadata>(metadataUrl, "Robinhood MCP protected-resource metadata");
  const resource = typeof protectedResource.resource === "string" && protectedResource.resource ? protectedResource.resource : mcpUrl;
  const authorizationServer = firstString(protectedResource.authorization_servers);
  if (!authorizationServer) throw new Error("Robinhood MCP protected-resource metadata did not include an authorization server.");

  const authServerMetadataUrl = oauthAuthorizationServerMetadataUrl(authorizationServer);
  const authorizationServerMetadata = await fetchJson<OAuthAuthorizationServerMetadata>(
    authServerMetadataUrl,
    "Robinhood MCP authorization-server metadata"
  );
  const authorizationUrl = firstString(authorizationServerMetadata.authorization_endpoint);
  const tokenUrl = firstString(authorizationServerMetadata.token_endpoint);
  if (!authorizationUrl || !tokenUrl) {
    throw new Error("Robinhood MCP authorization-server metadata did not include OAuth authorization and token endpoints.");
  }

  return {
    authorizationUrl,
    tokenUrl,
    registrationUrl: firstString(authorizationServerMetadata.registration_endpoint),
    redirectUri: options.redirectUri || process.env.ROBINHOOD_MCP_REDIRECT_URI || LOCAL_DEFAULT_REDIRECT_URI,
    resource: process.env.ROBINHOOD_MCP_RESOURCE || resource,
    scope: process.env.ROBINHOOD_MCP_SCOPES || firstString(authorizationServerMetadata.scopes_supported) || "tools:call",
    clientName: process.env.ROBINHOOD_MCP_CLIENT_NAME || "Socratic Trade"
  };
}

async function discoverProtectedResourceMetadataUrl(mcpUrl: string): Promise<string> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": process.env.ROBINHOOD_MCP_PROTOCOL_VERSION || DEFAULT_MCP_PROTOCOL_VERSION
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: process.env.ROBINHOOD_MCP_PROTOCOL_VERSION || DEFAULT_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "socratic-trade", version: "0.0.0" }
      }
    })
  });
  const authenticate = response.headers.get("www-authenticate");
  const metadataUrl = parseResourceMetadataUrl(authenticate);
  if (!metadataUrl) throw new Error("Robinhood MCP did not advertise OAuth resource metadata.");
  return metadataUrl;
}

function parseResourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  const quoted = header.match(/resource_metadata="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const bare = header.match(/resource_metadata=([^,\s]+)/i);
  return bare?.[1];
}

function oauthAuthorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  return new URL(`/.well-known/oauth-authorization-server${url.pathname}`, url.origin).toString();
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is string => typeof item === "string" && item.length > 0);
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function base64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
