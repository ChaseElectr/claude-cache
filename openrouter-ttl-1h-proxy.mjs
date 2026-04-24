#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVICE_NAME = "claude-openrouter-ttl-1h";
const SERVICE_VERSION = 8;
const LISTEN_HOST = readEnvString("CLAUDE_CACHE_HOST", "127.0.0.1");
const LISTEN_PORT = readEnvInteger("CLAUDE_CACHE_PORT", 3456);
const STATUS_PATH = "/__status";
const UPSTREAM_BASE_URL = new URL(
  readEnvString("OPENROUTER_BASE_URL", "https://openrouter.ai/api"),
);
const APP_SUPPORT_DIR = readEnvString(
  "CLAUDE_CACHE_APP_SUPPORT_DIR",
  path.join(os.homedir(), "Library", "Application Support", SERVICE_NAME),
);
const STATE_FILE = readEnvString(
  "CLAUDE_CACHE_STATE_FILE",
  path.join(APP_SUPPORT_DIR, "state.json"),
);
const STATE_DIR = path.dirname(STATE_FILE);
const DEFAULT_EPHEMERAL_CACHE_TTL_SECONDS = 5 * 60;
const OPUS_CACHE_TTL = "1h";
const OPUS_CACHE_TTL_SECONDS = 60 * 60;
const SESSION_RETENTION_MS = 6 * 60 * 60 * 1000;
const CACHE_WRITE_EVENT_RETENTION_MS = 30 * 60 * 60 * 1000;
const CACHE_WRITE_CHART_WINDOW_MS = 24 * 60 * 60 * 1000;
const CACHE_WRITE_CHART_BUCKET_MS = 60 * 60 * 1000;
const VERBOSE = readEnvBoolean("CLAUDE_CACHE_VERBOSE", false);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const persistedState = await loadPersistedState();
let persistTimer = null;

function readEnvString(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readEnvInteger(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function readEnvBoolean(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function log(...args) {
  if (VERBOSE) {
    console.error(`[${SERVICE_NAME}]`, ...args);
  }
}

function logInfo(...args) {
  console.error(`[${SERVICE_NAME}]`, ...args);
}

function nowIso() {
  return new Date().toISOString();
}

function parseIso(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

function toIsoFromMs(value) {
  return new Date(value).toISOString();
}

function addSeconds(isoString, seconds) {
  const time = parseIso(isoString);
  return time == null ? null : toIsoFromMs(time + seconds * 1000);
}

function coerceNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isJsonRequest(contentType = "") {
  return contentType.toLowerCase().includes("application/json");
}

function isJsonResponse(contentType = "") {
  return contentType.toLowerCase().includes("application/json");
}

function isEventStream(contentType = "") {
  return contentType.toLowerCase().includes("text/event-stream");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOpusModel(model) {
  const value = coerceString(model);
  return value ? value.toLowerCase().includes("opus") : false;
}

function parseCacheTtlSeconds(ttl) {
  const value = coerceString(ttl);
  if (!value) {
    return null;
  }

  const match = /^(\d+)\s*([smhd])$/i.exec(value);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  switch (match[2].toLowerCase()) {
    case "s":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 60 * 60;
    case "d":
      return amount * 60 * 60 * 24;
    default:
      return null;
  }
}

function resolveCacheControlTtlSeconds(cacheControl) {
  if (!isObject(cacheControl) || cacheControl.type !== "ephemeral") {
    return null;
  }

  const explicitTtlSeconds = parseCacheTtlSeconds(cacheControl.ttl);
  if (explicitTtlSeconds != null) {
    return explicitTtlSeconds;
  }

  return DEFAULT_EPHEMERAL_CACHE_TTL_SECONDS;
}

function findNestedCacheTtlSeconds(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const ttlSeconds = findNestedCacheTtlSeconds(item);
      if (ttlSeconds != null) {
        return ttlSeconds;
      }
    }
    return null;
  }

  if (!isObject(value)) {
    return null;
  }

  if (isObject(value.cache_control)) {
    const ttlSeconds = resolveCacheControlTtlSeconds(value.cache_control);
    if (ttlSeconds != null) {
      return ttlSeconds;
    }
  }

  for (const child of Object.values(value)) {
    const ttlSeconds = findNestedCacheTtlSeconds(child);
    if (ttlSeconds != null) {
      return ttlSeconds;
    }
  }

  return null;
}

function resolveRequestCacheTtlSeconds(payload) {
  const topLevelTtlSeconds = resolveCacheControlTtlSeconds(payload?.cache_control);
  if (topLevelTtlSeconds != null) {
    return topLevelTtlSeconds;
  }

  return findNestedCacheTtlSeconds({
    system: payload?.system,
    messages: payload?.messages,
    tools: payload?.tools,
  });
}

function joinPath(basePath, requestPath) {
  const left = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const right = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${left}${right}` || "/";
}

function buildUpstreamUrl(requestUrl = "/") {
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  const upstream = new URL(UPSTREAM_BASE_URL);
  upstream.pathname = joinPath(UPSTREAM_BASE_URL.pathname, incoming.pathname);
  upstream.search = incoming.search;
  return upstream;
}

function createInitialState() {
  return {
    version: SERVICE_VERSION,
    service: {
      started_at: nowIso(),
      last_updated_at: nowIso(),
      total_requests_served: 0,
      total_generations_observed: 0,
    },
    sessions: {},
    cache_write_events: [],
  };
}

function normalizeLoadedSession(session) {
  const normalized = {
    id: coerceString(session?.id),
    source: coerceString(session?.source) || "unknown",
    created_at: coerceString(session?.created_at) || nowIso(),
    last_seen_at: coerceString(session?.last_seen_at) || nowIso(),
    first_cache_at: coerceString(session?.first_cache_at) || null,
    first_cache_expires_at: coerceString(session?.first_cache_expires_at) || null,
    cache_ttl_seconds: coerceNumber(session?.cache_ttl_seconds),
    latest_model: coerceString(session?.latest_model),
    latest_provider: coerceString(session?.latest_provider),
    request_count: coerceNumber(session?.request_count) || 0,
    generation_count: coerceNumber(session?.generation_count) || 0,
    total_input_tokens: coerceNumber(session?.total_input_tokens) || 0,
    total_output_tokens: coerceNumber(session?.total_output_tokens) || 0,
    total_cache_creation_input_tokens:
      coerceNumber(session?.total_cache_creation_input_tokens) || 0,
    total_cache_read_input_tokens: coerceNumber(session?.total_cache_read_input_tokens) || 0,
    total_tokens: coerceNumber(session?.total_tokens) || 0,
    total_cost_usd: coerceNumber(session?.total_cost_usd) || 0,
    total_cache_discount_usd: coerceNumber(session?.total_cache_discount_usd) || 0,
    total_upstream_inference_cost_usd:
      coerceNumber(session?.total_upstream_inference_cost_usd) || 0,
    last_generation_id: coerceString(session?.last_generation_id),
    last_request_id: coerceString(session?.last_request_id),
    generations: {},
  };

  if (isObject(session?.generations)) {
    for (const [generationId, generation] of Object.entries(session.generations)) {
      normalized.generations[generationId] = {
        usage_applied: Boolean(generation?.usage_applied),
        cost_applied: Boolean(generation?.cost_applied),
        cost_source: coerceString(generation?.cost_source),
        created_at: coerceString(generation?.created_at),
        input_tokens: coerceNumber(generation?.input_tokens),
        output_tokens: coerceNumber(generation?.output_tokens),
        cache_creation_input_tokens: coerceNumber(generation?.cache_creation_input_tokens),
        cache_read_input_tokens: coerceNumber(generation?.cache_read_input_tokens),
        total_tokens: coerceNumber(generation?.total_tokens),
        cache_write_at: coerceString(generation?.cache_write_at),
        cache_write_expires_at: coerceString(generation?.cache_write_expires_at),
        total_cost_usd: coerceNumber(generation?.total_cost_usd),
        cache_discount_usd: coerceNumber(generation?.cache_discount_usd),
        upstream_inference_cost_usd: coerceNumber(generation?.upstream_inference_cost_usd),
      };
    }
  }

  return normalized;
}

function normalizeCacheWriteEvent(event) {
  const id = coerceString(event?.id) || coerceString(event?.generation_id);
  if (!id) {
    return null;
  }

  const createdAt = coerceString(event?.created_at);
  if (!createdAt || parseIso(createdAt) == null) {
    return null;
  }

  return {
    id,
    generation_id: coerceString(event?.generation_id),
    session_id: coerceString(event?.session_id) || "unknown",
    source: coerceString(event?.source) || "unknown",
    created_at: createdAt,
    expires_at: coerceString(event?.expires_at),
    latest_model: coerceString(event?.latest_model),
    latest_provider: coerceString(event?.latest_provider),
    input_tokens: coerceNumber(event?.input_tokens) || 0,
    output_tokens: coerceNumber(event?.output_tokens) || 0,
    cache_creation_input_tokens: coerceNumber(event?.cache_creation_input_tokens) || 0,
    cache_read_input_tokens: coerceNumber(event?.cache_read_input_tokens) || 0,
    total_tokens: coerceNumber(event?.total_tokens) || 0,
    total_cost_usd: coerceNumber(event?.total_cost_usd) || 0,
    request_id: coerceString(event?.request_id),
  };
}

async function loadPersistedState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const state = createInitialState();

    if (isObject(parsed?.service)) {
      state.service.started_at = coerceString(parsed.service.started_at) || state.service.started_at;
      state.service.last_updated_at =
        coerceString(parsed.service.last_updated_at) || state.service.last_updated_at;
      state.service.total_requests_served =
        coerceNumber(parsed.service.total_requests_served) || 0;
      state.service.total_generations_observed =
        coerceNumber(parsed.service.total_generations_observed) || 0;
    }

    if (isObject(parsed?.sessions)) {
      for (const [sessionId, session] of Object.entries(parsed.sessions)) {
        const normalized = normalizeLoadedSession({ id: sessionId, ...session });
        if (normalized.id) {
          state.sessions[normalized.id] = normalized;
        }
      }
    }

    if (Array.isArray(parsed?.cache_write_events)) {
      for (const event of parsed.cache_write_events) {
        const normalized = normalizeCacheWriteEvent(event);
        if (normalized) {
          state.cache_write_events.push(normalized);
        }
      }
    }

    return state;
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") {
      logInfo("failed to load persisted state:", error.message);
    }
    return createInitialState();
  }
}

function pruneState() {
  const now = Date.now();
  for (const [sessionId, session] of Object.entries(persistedState.sessions)) {
    const lastSeenAt = parseIso(session.last_seen_at);
    const firstCacheExpiresAt = parseIso(session.first_cache_expires_at);
    const staleByLastSeen = lastSeenAt != null && now - lastSeenAt > SESSION_RETENTION_MS;
    const staleByCache = firstCacheExpiresAt != null && firstCacheExpiresAt < now - SESSION_RETENTION_MS;
    if (staleByLastSeen || staleByCache) {
      delete persistedState.sessions[sessionId];
    }
  }

  if (Array.isArray(persistedState.cache_write_events)) {
    persistedState.cache_write_events = persistedState.cache_write_events.filter((event) => {
      const createdAt = parseIso(event.created_at);
      return createdAt != null && now - createdAt <= CACHE_WRITE_EVENT_RETENTION_MS;
    });
  } else {
    persistedState.cache_write_events = [];
  }
}

function schedulePersistState() {
  if (persistTimer) {
    return;
  }

  persistTimer = setTimeout(async () => {
    persistTimer = null;
    pruneState();
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(persistedState, null, 2));
    } catch (error) {
      logInfo("failed to persist state:", error.message);
    }
  }, 250);

  persistTimer.unref();
}

function touchServiceState() {
  persistedState.service.last_updated_at = nowIso();
  schedulePersistState();
}

function normalizeSessionId(value) {
  if (Array.isArray(value)) {
    return normalizeSessionId(value[0]);
  }
  const text = coerceString(value);
  if (!text) {
    return null;
  }
  return text.slice(0, 128);
}

function serializeFingerprintPart(value) {
  if (typeof value === "string") {
    return value.slice(0, 4096);
  }
  try {
    return JSON.stringify(value).slice(0, 4096);
  } catch {
    return String(value).slice(0, 4096);
  }
}

function deriveSessionId(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const firstSystemLikeMessage =
    messages.find((message) => message?.role === "system" || message?.role === "developer") ||
    null;
  const firstConversationMessage =
    messages.find((message) => message?.role !== "system" && message?.role !== "developer") ||
    null;
  const fingerprint = JSON.stringify({
    model: coerceString(payload?.model) || "",
    system: serializeFingerprintPart(payload?.system ?? firstSystemLikeMessage?.content ?? ""),
    first_turn: serializeFingerprintPart(firstConversationMessage?.content ?? ""),
  });

  return `cc_${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}

function resolveSessionInfo(payload, headers) {
  const bodySessionId = normalizeSessionId(payload?.session_id);
  if (bodySessionId) {
    return { id: bodySessionId, source: "body" };
  }

  const headerSessionId = normalizeSessionId(headers["x-session-id"]);
  if (headerSessionId) {
    return { id: headerSessionId, source: "header" };
  }

  return { id: deriveSessionId(payload), source: "derived" };
}

function forceNestedCacheControlsTo1h(value) {
  if (Array.isArray(value)) {
    let next = null;
    let patchedCount = 0;

    value.forEach((item, index) => {
      const patched = forceNestedCacheControlsTo1h(item);
      if (patched.patchedCount === 0) {
        return;
      }

      if (!next) {
        next = [...value];
      }
      next[index] = patched.value;
      patchedCount += patched.patchedCount;
    });

    return {
      value: next || value,
      patchedCount,
    };
  }

  if (!isObject(value)) {
    return { value, patchedCount: 0 };
  }

  let next = null;
  let patchedCount = 0;

  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control" && isObject(child)) {
      const cacheControlNeedsPatch =
        child.type !== "ephemeral" || child.ttl !== OPUS_CACHE_TTL;
      if (cacheControlNeedsPatch) {
        if (!next) {
          next = { ...value };
        }
        next[key] = {
          ...child,
          type: "ephemeral",
          ttl: OPUS_CACHE_TTL,
        };
        patchedCount += 1;
      }
      continue;
    }

    const patched = forceNestedCacheControlsTo1h(child);
    if (patched.patchedCount === 0) {
      continue;
    }

    if (!next) {
      next = { ...value };
    }
    next[key] = patched.value;
    patchedCount += patched.patchedCount;
  }

  return {
    value: next || value,
    patchedCount,
  };
}

function patchJsonPayload(json, requestPathname, headers) {
  const isMessagesRequest = /\/v1\/messages$/.test(requestPathname);
  if (!isMessagesRequest || !isObject(json)) {
    return { value: json, patchedCount: 0, sessionInfo: null };
  }

  const sessionInfo = resolveSessionInfo(json, headers);
  let patchedCount = 0;
  let next = json;

  if (json.session_id !== sessionInfo.id) {
    next = { ...next, session_id: sessionInfo.id };
    patchedCount += 1;
  }

  if (isOpusModel(next.model)) {
    const nestedCacheControls = forceNestedCacheControlsTo1h({
      system: next.system,
      messages: next.messages,
      tools: next.tools,
    });
    if (nestedCacheControls.patchedCount > 0) {
      next = {
        ...next,
        system: nestedCacheControls.value.system,
        messages: nestedCacheControls.value.messages,
        tools: nestedCacheControls.value.tools,
      };
      patchedCount += nestedCacheControls.patchedCount;
    }

    const cacheControl = next.cache_control;
    const topLevelNeedsPatch =
      !isObject(cacheControl) ||
      cacheControl.type !== "ephemeral" ||
      cacheControl.ttl !== OPUS_CACHE_TTL;
    if (topLevelNeedsPatch) {
      next = {
        ...next,
        cache_control: {
          ...(isObject(cacheControl) ? cacheControl : {}),
          type: "ephemeral",
          ttl: OPUS_CACHE_TTL,
        },
      };
      patchedCount += 1;
    }
  }

  return {
    value: next,
    patchedCount,
    sessionInfo,
  };
}

function ensureSession(sessionInfo, body) {
  const currentTime = nowIso();
  const existing = persistedState.sessions[sessionInfo.id];
  const session =
    existing ||
    {
      id: sessionInfo.id,
      source: sessionInfo.source,
      created_at: currentTime,
      last_seen_at: currentTime,
      first_cache_at: null,
      first_cache_expires_at: null,
      cache_ttl_seconds: null,
      latest_model: null,
      latest_provider: null,
      request_count: 0,
      generation_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_input_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      total_cache_discount_usd: 0,
      total_upstream_inference_cost_usd: 0,
      last_generation_id: null,
      last_request_id: null,
      generations: {},
    };

  session.source = sessionInfo.source;
  session.last_seen_at = currentTime;
  session.latest_model = coerceString(body?.model) || session.latest_model;
  session.request_count += 1;

  const cacheTtlSeconds = resolveRequestCacheTtlSeconds(body);
  if (cacheTtlSeconds != null) {
    session.cache_ttl_seconds = cacheTtlSeconds;
    const existingExpiry = parseIso(session.first_cache_expires_at);
    if (!session.first_cache_at || existingExpiry == null || existingExpiry <= Date.now()) {
      session.first_cache_at = currentTime;
      session.first_cache_expires_at = addSeconds(currentTime, cacheTtlSeconds);
    }
  }

  persistedState.sessions[sessionInfo.id] = session;
  persistedState.service.total_requests_served += 1;
  touchServiceState();
  return session;
}

function ensureGenerationRecord(session, generationId) {
  if (!generationId) {
    return null;
  }
  if (!isObject(session.generations[generationId])) {
    session.generations[generationId] = {
      usage_applied: false,
      cost_applied: false,
      cost_source: null,
      created_at: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_tokens: null,
      cache_write_at: null,
      cache_write_expires_at: null,
      total_cost_usd: null,
      cache_discount_usd: null,
      upstream_inference_cost_usd: null,
    };
  }
  return session.generations[generationId];
}

function buildCacheWriteEvent(session, generationId, generation) {
  const cacheWriteTokens =
    coerceNumber(generation?.cache_creation_input_tokens) ||
    coerceNumber(session?.total_cache_creation_input_tokens) ||
    0;
  if (cacheWriteTokens <= 0) {
    return null;
  }

  const createdAt =
    coerceString(generation?.cache_write_at) ||
    coerceString(session?.first_cache_at) ||
    coerceString(generation?.created_at);
  if (!createdAt) {
    return null;
  }

  const id =
    coerceString(generationId) ||
    coerceString(session?.last_generation_id) ||
    `cache_${crypto.createHash("sha256").update(`${session?.id || "unknown"}:${createdAt}`).digest("hex").slice(0, 24)}`;

  return normalizeCacheWriteEvent({
    id,
    generation_id: coerceString(generationId) || coerceString(session?.last_generation_id),
    session_id: session?.id,
    source: session?.source,
    created_at: createdAt,
    expires_at: coerceString(generation?.cache_write_expires_at) || session?.first_cache_expires_at,
    latest_model: session?.latest_model,
    latest_provider: session?.latest_provider,
    input_tokens:
      coerceNumber(generation?.input_tokens) ?? coerceNumber(session?.total_input_tokens) ?? 0,
    output_tokens:
      coerceNumber(generation?.output_tokens) ?? coerceNumber(session?.total_output_tokens) ?? 0,
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens:
      coerceNumber(generation?.cache_read_input_tokens) ??
      coerceNumber(session?.total_cache_read_input_tokens) ??
      0,
    total_tokens:
      coerceNumber(generation?.total_tokens) ?? coerceNumber(session?.total_tokens) ?? 0,
    total_cost_usd:
      coerceNumber(generation?.total_cost_usd) ?? coerceNumber(session?.total_cost_usd) ?? 0,
    request_id: session?.last_request_id,
  });
}

function upsertCacheWriteEvent(session, generationId, generation) {
  const event = buildCacheWriteEvent(session, generationId, generation);
  if (!event) {
    return;
  }

  const index = persistedState.cache_write_events.findIndex((item) => item.id === event.id);
  if (index === -1) {
    persistedState.cache_write_events.push(event);
  } else {
    persistedState.cache_write_events[index] = {
      ...persistedState.cache_write_events[index],
      ...event,
    };
  }
}

function extractUsage(usage) {
  if (!isObject(usage)) {
    return null;
  }

  const inputTokens = coerceNumber(usage.input_tokens) ?? coerceNumber(usage.prompt_tokens) ?? 0;
  const outputTokens =
    coerceNumber(usage.output_tokens) ?? coerceNumber(usage.completion_tokens) ?? 0;
  const cacheCreationInputTokens =
    coerceNumber(usage.cache_creation_input_tokens) ??
    coerceNumber(usage.prompt_tokens_details?.cache_write_tokens) ??
    0;
  const cacheReadInputTokens =
    coerceNumber(usage.cache_read_input_tokens) ??
    coerceNumber(usage.prompt_tokens_details?.cached_tokens) ??
    0;
  const explicitTotalTokens = coerceNumber(usage.total_tokens);
  const upstreamInferenceCostUsd =
    coerceNumber(usage.cost_details?.upstream_inference_cost) ??
    (() => {
      const inputCost = coerceNumber(usage.cost_details?.upstream_inference_input_cost);
      const outputCost = coerceNumber(usage.cost_details?.upstream_inference_output_cost);
      if (inputCost == null && outputCost == null) {
        return null;
      }
      return (inputCost || 0) + (outputCost || 0);
    })();

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    total_tokens:
      explicitTotalTokens ??
      (coerceNumber(usage.input_tokens) != null || coerceNumber(usage.output_tokens) != null
        ? inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
        : inputTokens + outputTokens),
    total_cost_usd: coerceNumber(usage.cost),
    upstream_inference_cost_usd: upstreamInferenceCostUsd,
  };
}

function applyCostSnapshotToSession(session, record, snapshot, options = {}) {
  if (!session || !record || !snapshot) {
    return false;
  }

  let changed = false;
  const pairs = [
    ["total_cost_usd", "total_cost_usd"],
    ["cache_discount_usd", "total_cache_discount_usd"],
    ["upstream_inference_cost_usd", "total_upstream_inference_cost_usd"],
  ];

  for (const [recordKey, sessionKey] of pairs) {
    const nextValue = coerceNumber(snapshot[recordKey]);
    if (nextValue == null) {
      continue;
    }

    const previousValue = coerceNumber(record[recordKey]) || 0;
    session[sessionKey] += nextValue - previousValue;
    record[recordKey] = nextValue;
    changed = true;
  }

  if (snapshot.created_at) {
    record.created_at = snapshot.created_at;
  }
  if (snapshot.cost_source) {
    record.cost_source = snapshot.cost_source;
  }
  if (options.markCostApplied) {
    record.cost_applied = true;
  }

  return changed;
}

function applyUsageToSession(session, generationId, usage) {
  if (!usage) {
    return;
  }

  const record = ensureGenerationRecord(session, generationId);
  if (record?.usage_applied) {
    return;
  }

  session.total_input_tokens += usage.input_tokens;
  session.total_output_tokens += usage.output_tokens;
  session.total_cache_creation_input_tokens += usage.cache_creation_input_tokens;
  session.total_cache_read_input_tokens += usage.cache_read_input_tokens;
  session.total_tokens += usage.total_tokens;
  session.last_seen_at = nowIso();

  if (generationId) {
    session.last_generation_id = generationId;
  }

  if (record) {
    record.input_tokens = usage.input_tokens;
    record.output_tokens = usage.output_tokens;
    record.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    record.cache_read_input_tokens = usage.cache_read_input_tokens;
    record.total_tokens = usage.total_tokens;
    record.usage_applied = true;
    if (usage.cache_creation_input_tokens > 0) {
      const cacheWriteAt = nowIso();
      const cacheTtlSeconds = session.cache_ttl_seconds || DEFAULT_EPHEMERAL_CACHE_TTL_SECONDS;
      record.cache_write_at = cacheWriteAt;
      record.cache_write_expires_at = addSeconds(cacheWriteAt, cacheTtlSeconds);
    }
    applyCostSnapshotToSession(
      session,
      record,
      {
        total_cost_usd: usage.total_cost_usd,
        upstream_inference_cost_usd: usage.upstream_inference_cost_usd,
        cost_source: "response",
      },
      { markCostApplied: true },
    );
    upsertCacheWriteEvent(session, generationId, record);
  } else {
    if (usage.total_cost_usd != null) {
      session.total_cost_usd += usage.total_cost_usd;
    }
    if (usage.upstream_inference_cost_usd != null) {
      session.total_upstream_inference_cost_usd += usage.upstream_inference_cost_usd;
    }
  }
  session.generation_count = Object.keys(session.generations).length;
  persistedState.service.total_generations_observed = Object.values(persistedState.sessions).reduce(
    (sum, currentSession) => sum + Object.keys(currentSession.generations).length,
    0,
  );
  touchServiceState();
}

function buildHeaders(reqHeaders) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function transformBody(req, rawBody, requestUrl) {
  const method = (req.method || "GET").toUpperCase();
  if (rawBody.length === 0 || method === "GET" || method === "HEAD") {
    return {
      body: undefined,
      patchedCount: 0,
      sessionInfo: null,
      parsedBody: null,
    };
  }

  const contentType = req.headers["content-type"] || "";
  if (!isJsonRequest(contentType)) {
    return {
      body: rawBody,
      patchedCount: 0,
      sessionInfo: null,
      parsedBody: null,
    };
  }

  try {
    const json = JSON.parse(rawBody.toString("utf8"));
    const { value, patchedCount, sessionInfo } = patchJsonPayload(
      json,
      requestUrl.pathname,
      req.headers,
    );

    return {
      body: Buffer.from(JSON.stringify(value)),
      patchedCount,
      sessionInfo,
      parsedBody: value,
    };
  } catch (error) {
    log("skip non-parseable JSON body:", error instanceof Error ? error.message : String(error));
    return {
      body: rawBody,
      patchedCount: 0,
      sessionInfo: null,
      parsedBody: null,
    };
  }
}

function buildResponseHeaders(upstreamResponse) {
  const headers = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  return headers;
}

function buildStatusSnapshot() {
  pruneState();
  const now = Date.now();
  const normalizedSessions = Object.values(persistedState.sessions).map((session) => {
    const normalized = {
      id: session.id,
      source: session.source,
      created_at: session.created_at,
      last_seen_at: session.last_seen_at,
      first_cache_at: session.first_cache_at,
      first_cache_expires_at: session.first_cache_expires_at,
      cache_ttl_seconds: session.cache_ttl_seconds,
      latest_model: session.latest_model,
      latest_provider: session.latest_provider,
      request_count: session.request_count,
      generation_count: session.generation_count,
      total_input_tokens: session.total_input_tokens,
      total_output_tokens: session.total_output_tokens,
      total_cache_creation_input_tokens: session.total_cache_creation_input_tokens,
      total_cache_read_input_tokens: session.total_cache_read_input_tokens,
      total_tokens: session.total_tokens,
      total_cost_usd: session.total_cost_usd,
      total_cache_discount_usd: session.total_cache_discount_usd,
      total_upstream_inference_cost_usd: session.total_upstream_inference_cost_usd,
      last_generation_id: session.last_generation_id,
      last_request_id: session.last_request_id,
      generations: isObject(session.generations) ? session.generations : {},
    };
    return normalized;
  });

  const sessions = normalizedSessions
    .map((session) => {
      const expiresAt = parseIso(session.first_cache_expires_at);
      const remainingSeconds =
        expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
      return {
        id: session.id,
        source: session.source,
        created_at: session.created_at,
        last_seen_at: session.last_seen_at,
        first_cache_at: session.first_cache_at,
        first_cache_expires_at: session.first_cache_expires_at,
        first_cache_remaining_seconds: remainingSeconds,
        cache_ttl_seconds: session.cache_ttl_seconds,
        is_active: remainingSeconds == null ? false : remainingSeconds > 0,
        latest_model: session.latest_model,
        latest_provider: session.latest_provider,
        request_count: session.request_count,
        generation_count: session.generation_count,
        total_input_tokens: session.total_input_tokens,
        total_output_tokens: session.total_output_tokens,
        total_cache_creation_input_tokens: session.total_cache_creation_input_tokens,
        total_cache_read_input_tokens: session.total_cache_read_input_tokens,
        total_tokens: session.total_tokens,
        total_cost_usd: session.total_cost_usd,
        total_cache_discount_usd: session.total_cache_discount_usd,
        total_upstream_inference_cost_usd: session.total_upstream_inference_cost_usd,
        last_generation_id: session.last_generation_id,
        last_request_id: session.last_request_id,
      };
    })
    .sort((left, right) => {
      const leftTime = parseIso(left.last_seen_at) || 0;
      const rightTime = parseIso(right.last_seen_at) || 0;
      return rightTime - leftTime;
    });

  const sessionCacheWrites = normalizedSessions
    .flatMap((session) => {
      const writes = [];

      for (const [generationId, generation] of Object.entries(session.generations)) {
        const cacheWriteTokens = coerceNumber(generation?.cache_creation_input_tokens) || 0;
        if (cacheWriteTokens <= 0) {
          continue;
        }

        const expiresAtIso =
          coerceString(generation?.cache_write_expires_at) || session.first_cache_expires_at;
        const expiresAt = parseIso(expiresAtIso);
        const remainingSeconds =
          expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));

        writes.push({
          id: generationId,
          generation_id: generationId,
          session_id: session.id,
          source: session.source,
          created_at: coerceString(generation?.cache_write_at) || session.first_cache_at,
          expires_at: expiresAtIso,
          remaining_seconds: remainingSeconds,
          is_active: remainingSeconds == null ? false : remainingSeconds > 0,
          latest_model: session.latest_model,
          latest_provider: session.latest_provider,
          input_tokens: coerceNumber(generation?.input_tokens) || 0,
          output_tokens: coerceNumber(generation?.output_tokens) || 0,
          cache_creation_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: coerceNumber(generation?.cache_read_input_tokens) || 0,
          total_tokens: coerceNumber(generation?.total_tokens) || 0,
          total_cost_usd: coerceNumber(generation?.total_cost_usd) || 0,
          request_id: session.last_request_id,
        });
      }

      if (
        writes.length === 0 &&
        session.total_cache_creation_input_tokens > 0 &&
        session.first_cache_expires_at
      ) {
        const expiresAt = parseIso(session.first_cache_expires_at);
        const remainingSeconds =
          expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
        writes.push({
          id: session.last_generation_id || `cache_${session.id}`,
          generation_id: session.last_generation_id,
          session_id: session.id,
          source: session.source,
          created_at: session.first_cache_at,
          expires_at: session.first_cache_expires_at,
          remaining_seconds: remainingSeconds,
          is_active: remainingSeconds == null ? false : remainingSeconds > 0,
          latest_model: session.latest_model,
          latest_provider: session.latest_provider,
          input_tokens: session.total_input_tokens,
          output_tokens: session.total_output_tokens,
          cache_creation_input_tokens: session.total_cache_creation_input_tokens,
          cache_read_input_tokens: session.total_cache_read_input_tokens,
          total_tokens: session.total_tokens,
          total_cost_usd: session.total_cost_usd,
          request_id: session.last_request_id,
        });
      }

      return writes;
    })
    .sort((left, right) => {
      const leftTime = parseIso(left.expires_at) || 0;
      const rightTime = parseIso(right.expires_at) || 0;
      return rightTime - leftTime;
    });

  const cacheWriteEventsById = new Map();
  for (const event of persistedState.cache_write_events) {
    cacheWriteEventsById.set(event.id, event);
  }
  for (const event of sessionCacheWrites) {
    cacheWriteEventsById.set(event.id, {
      ...(cacheWriteEventsById.get(event.id) || {}),
      ...event,
    });
  }

  const cacheWrites = Array.from(cacheWriteEventsById.values())
    .map((event) => {
      const expiresAt = parseIso(event.expires_at);
      const remainingSeconds =
        expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
      return {
        ...event,
        remaining_seconds: remainingSeconds,
        is_active: remainingSeconds == null ? false : remainingSeconds > 0,
      };
    })
    .sort((left, right) => {
      const leftTime = parseIso(left.expires_at) || 0;
      const rightTime = parseIso(right.expires_at) || 0;
      return rightTime - leftTime;
    });

  const activeSessions = sessions.filter((session) => session.is_active);
  const activeCacheWrites = cacheWrites.filter((cacheWrite) => cacheWrite.is_active);
  const chartWindowStart =
    Math.floor(now / CACHE_WRITE_CHART_BUCKET_MS) * CACHE_WRITE_CHART_BUCKET_MS -
    23 * CACHE_WRITE_CHART_BUCKET_MS;
  const cacheWriteBuckets24h = Array.from({ length: 24 }, (_, index) => {
    const startsAtMs = chartWindowStart + index * CACHE_WRITE_CHART_BUCKET_MS;
    return {
      starts_at: toIsoFromMs(startsAtMs),
      ends_at: toIsoFromMs(startsAtMs + CACHE_WRITE_CHART_BUCKET_MS),
      cache_creation_input_tokens: 0,
      write_count: 0,
      active_write_count: 0,
      total_cost_usd: 0,
    };
  });

  for (const event of cacheWrites) {
    const createdAt = parseIso(event.created_at);
    if (createdAt == null || createdAt < chartWindowStart) {
      continue;
    }
    const bucketIndex = Math.floor((createdAt - chartWindowStart) / CACHE_WRITE_CHART_BUCKET_MS);
    if (bucketIndex < 0 || bucketIndex >= cacheWriteBuckets24h.length) {
      continue;
    }
    const bucket = cacheWriteBuckets24h[bucketIndex];
    bucket.cache_creation_input_tokens += event.cache_creation_input_tokens;
    bucket.write_count += 1;
    bucket.total_cost_usd += event.total_cost_usd;
    if (event.is_active) {
      bucket.active_write_count += 1;
    }
  }

  const totals = sessions.reduce(
    (sum, session) => {
      sum.total_input_tokens += session.total_input_tokens;
      sum.total_output_tokens += session.total_output_tokens;
      sum.total_cache_creation_input_tokens += session.total_cache_creation_input_tokens;
      sum.total_cache_read_input_tokens += session.total_cache_read_input_tokens;
      sum.total_tokens += session.total_tokens;
      sum.total_cost_usd += session.total_cost_usd;
      sum.total_cache_discount_usd += session.total_cache_discount_usd;
      sum.total_upstream_inference_cost_usd += session.total_upstream_inference_cost_usd;
      return sum;
    },
    {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_input_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      total_cache_discount_usd: 0,
      total_upstream_inference_cost_usd: 0,
    },
  );
  const startedAt = parseIso(persistedState.service.started_at) || Date.now();

  return {
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      pid: process.pid,
      healthy: true,
      started_at: persistedState.service.started_at,
      uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      last_updated_at: persistedState.service.last_updated_at,
      listen_host: LISTEN_HOST,
      listen_port: LISTEN_PORT,
      upstream_base_url: UPSTREAM_BASE_URL.href,
      cache_ttl_seconds: OPUS_CACHE_TTL_SECONDS,
      total_requests_served: persistedState.service.total_requests_served,
      total_generations_observed: persistedState.service.total_generations_observed,
      total_input_tokens: totals.total_input_tokens,
      total_output_tokens: totals.total_output_tokens,
      total_cache_creation_input_tokens: totals.total_cache_creation_input_tokens,
      total_cache_read_input_tokens: totals.total_cache_read_input_tokens,
      total_tokens: totals.total_tokens,
      total_cost_usd: totals.total_cost_usd,
      total_cache_discount_usd: totals.total_cache_discount_usd,
      total_upstream_inference_cost_usd: totals.total_upstream_inference_cost_usd,
      active_session_count: activeSessions.length,
      tracked_session_count: sessions.length,
      active_cache_write_count: activeCacheWrites.length,
      tracked_cache_write_count: cacheWrites.length,
      cache_write_chart_window_seconds: Math.floor(CACHE_WRITE_CHART_WINDOW_MS / 1000),
      cache_write_chart_bucket_seconds: Math.floor(CACHE_WRITE_CHART_BUCKET_MS / 1000),
      status_endpoint: `http://${LISTEN_HOST}:${LISTEN_PORT}${STATUS_PATH}`,
    },
    cache_write_buckets_24h: cacheWriteBuckets24h,
    cache_writes: cacheWrites,
    sessions,
  };
}

function createStreamParser(onPayload) {
  let textBuffer = "";
  let dataLines = [];

  function dispatch() {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];

    if (data === "[DONE]") {
      return;
    }

    try {
      onPayload(JSON.parse(data));
    } catch (error) {
      log("failed to parse SSE payload:", error.message);
    }
  }

  return {
    push(chunk) {
      textBuffer += chunk;
      while (true) {
        const newlineIndex = textBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        let line = textBuffer.slice(0, newlineIndex);
        textBuffer = textBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        if (!line) {
          dispatch();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    },
    flush() {
      dispatch();
    },
  };
}

async function handleStatusRequest(res) {
  const payload = buildStatusSnapshot();
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function handleBufferedResponse(upstreamResponse, res, context) {
  const rawBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  const headers = buildResponseHeaders(upstreamResponse);
  headers["content-length"] = String(rawBuffer.length);
  res.writeHead(upstreamResponse.status, headers);
  res.end(rawBuffer);

  if (!context.session || !isJsonResponse(upstreamResponse.headers.get("content-type") || "")) {
    return;
  }

  try {
    const payload = JSON.parse(rawBuffer.toString("utf8"));
    const generationId = normalizeSessionId(payload?.id);
    const usage = extractUsage(payload?.usage);
    applyUsageToSession(context.session, generationId, usage);
  } catch (error) {
    log("failed to process buffered response metrics:", error.message);
  }
}

async function handleStreamingResponse(upstreamResponse, res, context) {
  const headers = buildResponseHeaders(upstreamResponse);
  res.writeHead(upstreamResponse.status, headers);

  const decoder = new TextDecoder();
  let generationId = null;
  let latestUsage = null;

  const parser = createStreamParser((payload) => {
    if (payload?.type === "message_start" && isObject(payload.message)) {
      generationId = normalizeSessionId(payload.message.id) || generationId;
      latestUsage = extractUsage(payload.message.usage) || latestUsage;
    } else if (payload?.type === "message_delta") {
      latestUsage = extractUsage(payload.usage) || latestUsage;
    }
  });

  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    res.write(Buffer.from(value));
    parser.push(decoder.decode(value, { stream: true }));
  }

  parser.push(decoder.decode());
  parser.flush();
  res.end();

  if (!context.session) {
    return;
  }

  applyUsageToSession(context.session, generationId, latestUsage);
}

async function handleProxyRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (requestUrl.pathname === STATUS_PATH) {
    await handleStatusRequest(res);
    return;
  }

  const rawBody = await readRequestBody(req);
  const { body, patchedCount, sessionInfo, parsedBody } = await transformBody(
    req,
    rawBody,
    requestUrl,
  );
  const method = (req.method || "GET").toUpperCase();
  const headers = buildHeaders(req.headers);
  const upstreamUrl = buildUpstreamUrl(req.url);
  const session = sessionInfo && parsedBody ? ensureSession(sessionInfo, parsedBody) : null;

  log(method, req.url || "/", "patched top-level fields:", patchedCount);

  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    duplex: body ? "half" : undefined,
    redirect: "manual",
  });

  const context = { session };

  if (isEventStream(upstreamResponse.headers.get("content-type") || "")) {
    await handleStreamingResponse(upstreamResponse, res, context);
    return;
  }

  await handleBufferedResponse(upstreamResponse, res, context);
}

async function handleRequest(req, res) {
  try {
    await handleProxyRequest(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logInfo("proxy error:", message);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message }));
  }
}

function startStateMaintenance() {
  pruneState();
  setInterval(() => {
    pruneState();
    touchServiceState();
  }, 30_000).unref();
}

export { buildStatusSnapshot, buildUpstreamUrl, patchJsonPayload };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStateMaintenance();

  const server = http.createServer(handleRequest);
  server.on("clientError", (error, socket) => {
    logInfo("client error:", error.message);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    logInfo(`listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_BASE_URL.href}`);
    logInfo(`status endpoint available at http://${LISTEN_HOST}:${LISTEN_PORT}${STATUS_PATH}`);
  });
}
