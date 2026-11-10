export type UnknownRecord = Record<string, unknown>;

interface NormalizedHetznerServer {
  name?: string;
  status?: string;
  serverType?: string;
  cpus?: number;
  memoryGb?: number;
  location?: string;
  ip?: string;
}

export interface NormalizedCoolifyResource {
  uuid: string;
  name: string;
  type: string;
  status: string;
}

const MAX_NORMALIZED_COOLIFY_RESOURCES = 500;
const MAX_COOLIFY_RESOURCE_WARNINGS = 20;

export function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

export function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readPositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * Accepts 0 as a real measurement.
 *
 * Use this for anything where zero is a legitimate reading — free memory, uptime on a
 * just-booted host. `readPositiveNumber` maps 0 to `undefined`, which renders as
 * "Utilization unavailable": an active out-of-memory condition, the exact thing an operator
 * opens this panel to find, would be displayed as a shrug.
 */
export function readNonNegativeNumber(value: unknown): number | undefined {
  // Guard the input type explicitly: Number(null) and Number("") are both 0, so a bare
  // Number() coercion would turn "the provider omitted this field" into "measured zero" —
  // the precise confusion this helper exists to remove.
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/**
 * Hetzner's real server response nests display values under
 * `server_type.name` and `public_net.ipv4.ip`. Keep support for the earlier
 * flattened fixture shape, but report malformed provider fields instead of
 * silently pretending they were valid.
 */
export function normalizeHetznerServerResponse(payload: unknown): {
  server: NormalizedHetznerServer;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = asRecord(payload);
  const server = asRecord(root?.server);
  if (!server) {
    return {
      server: {},
      warnings: ["Hetzner response did not contain a server object."],
    };
  }

  const serverTypeRaw = server.server_type;
  const serverTypeRecord = asRecord(serverTypeRaw);
  const serverType = readText(serverTypeRaw) ?? readText(serverTypeRecord?.name);
  if (serverTypeRaw !== undefined && !serverType) {
    warnings.push("Hetzner server_type.name was not a non-empty string.");
  }
  const cpus = readPositiveNumber(serverTypeRecord?.cores);
  if (serverTypeRecord?.cores !== undefined && !cpus) {
    warnings.push("Hetzner server_type.cores was not a positive number.");
  }
  const memoryGb = readPositiveNumber(serverTypeRecord?.memory);
  if (serverTypeRecord?.memory !== undefined && !memoryGb) {
    warnings.push("Hetzner server_type.memory was not a positive number.");
  }

  const publicNet = asRecord(server.public_net);
  const ipv4Raw = publicNet?.ipv4;
  const ip = readText(ipv4Raw) ?? readText(asRecord(ipv4Raw)?.ip);
  if (ipv4Raw !== undefined && !ip) {
    warnings.push("Hetzner public_net.ipv4.ip was not a non-empty string.");
  }

  const location = readText(asRecord(server.location)?.name)
    ?? readText(asRecord(server.datacenter)?.name)
    ?? readText(asRecord(asRecord(server.datacenter)?.location)?.name);

  return {
    server: {
      name: readText(server.name),
      status: readText(server.status),
      serverType,
      cpus,
      memoryGb,
      location,
      ip,
    },
    warnings,
  };
}

export function normalizeCoolifyResources(payload: unknown): {
  resources: NormalizedCoolifyResource[];
  warnings: string[];
} {
  if (!Array.isArray(payload)) {
    return {
      resources: [],
      warnings: ["Coolify resources response was not an array."],
    };
  }

  const resources: NormalizedCoolifyResource[] = [];
  const warnings: string[] = [];
  let malformedCount = 0;
  const processedCount = Math.min(payload.length, MAX_NORMALIZED_COOLIFY_RESOURCES);
  for (let index = 0; index < processedCount; index += 1) {
    const value = payload[index];
    const resource = asRecord(value);
    const normalized = resource
      ? {
          uuid: readText(resource.uuid),
          name: readText(resource.name),
          type: readText(resource.type),
          status: readText(resource.status),
        }
      : undefined;
    if (!normalized?.uuid || !normalized.name || !normalized.type || !normalized.status) {
      malformedCount += 1;
      if (warnings.length < MAX_COOLIFY_RESOURCE_WARNINGS) {
        warnings.push(`Coolify resource at index ${index} had malformed display fields and was omitted.`);
      }
      continue;
    }
    resources.push(normalized as NormalizedCoolifyResource);
  }

  const summarizedMalformedCount = malformedCount - Math.min(malformedCount, MAX_COOLIFY_RESOURCE_WARNINGS);
  if (summarizedMalformedCount > 0) {
    warnings.push(`${summarizedMalformedCount} additional malformed Coolify resources were omitted.`);
  }
  if (payload.length > processedCount) {
    warnings.push(
      `Coolify returned ${payload.length} resources; only the first ${MAX_NORMALIZED_COOLIFY_RESOURCES} were processed.`,
    );
  }

  return { resources, warnings };
}
