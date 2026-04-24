import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";

process.env.CLAUDE_CACHE_STATE_FILE = path.join(
  os.tmpdir(),
  `claude-cache-monitor-test-${process.pid}.json`,
);
process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api";
process.env.CLAUDE_CACHE_HOST = "127.0.0.1";
process.env.CLAUDE_CACHE_PORT = "3456";

const { buildUpstreamUrl, patchJsonPayload } = await import("../openrouter-ttl-1h-proxy.mjs");

describe("buildUpstreamUrl", () => {
  it("maps local request paths onto the OpenRouter API base", () => {
    const url = buildUpstreamUrl("/v1/messages?stream=true");

    assert.equal(url.href, "https://openrouter.ai/api/v1/messages?stream=true");
  });
});

describe("patchJsonPayload", () => {
  it("adds session_id and 1h cache_control for Opus messages requests", () => {
    const payload = {
      model: "anthropic/claude-opus-4.1",
      messages: [{ role: "user", content: "hello" }],
    };

    const result = patchJsonPayload(payload, "/v1/messages", {});

    assert.equal(result.patchedCount, 2);
    assert.match(result.value.session_id, /^cc_[0-9a-f]{24}$/);
    assert.deepEqual(result.value.cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.equal(result.sessionInfo.source, "derived");
  });

  it("prefers explicit body session_id", () => {
    const payload = {
      model: "anthropic/claude-opus-4.1",
      session_id: "manual-session",
      messages: [{ role: "user", content: "hello" }],
    };

    const result = patchJsonPayload(payload, "/v1/messages", {
      "x-session-id": "header-session",
    });

    assert.equal(result.value.session_id, "manual-session");
    assert.equal(result.sessionInfo.source, "body");
  });

  it("rewrites nested cache controls only for Opus models", () => {
    const payload = {
      model: "anthropic/claude-3-opus",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    };

    const result = patchJsonPayload(payload, "/v1/messages", {});

    assert.equal(result.value.messages[0].content[0].cache_control.ttl, "1h");
    assert.equal(result.value.messages[0].content[0].cache_control.type, "ephemeral");
  });

  it("does not inject cache_control for non-Opus models", () => {
    const payload = {
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
    };

    const result = patchJsonPayload(payload, "/v1/messages", {
      "x-session-id": "from-header",
    });

    assert.equal(result.value.session_id, "from-header");
    assert.equal(result.value.cache_control, undefined);
    assert.equal(result.sessionInfo.source, "header");
  });

  it("leaves non-messages requests untouched", () => {
    const payload = { model: "anthropic/claude-opus-4.1" };

    const result = patchJsonPayload(payload, "/v1/models", {});

    assert.equal(result.value, payload);
    assert.equal(result.patchedCount, 0);
    assert.equal(result.sessionInfo, null);
  });
});
