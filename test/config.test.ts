import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateTokens } from "../src/config.js";
import type { SyncConfig } from "../src/types.js";

function config(fromToken: string, toToken: string): SyncConfig {
  return {
    version: 1,
    from: { apiToken: fromToken, workspaceId: 10 },
    to: { apiToken: toToken, workspaceId: 11 },
    projectMappings: {},
    copiedEntries: [],
  };
}

describe("token configuration", () => {
  it("allows the same API token for different workspaces in one account", () => {
    assert.doesNotThrow(() => validateTokens(config("shared-token", "shared-token")));
  });

  it("still rejects unset token placeholders", () => {
    assert.throws(
      () => validateTokens(config("PASTE_FROM_ACCOUNT_API_TOKEN_HERE", "to-token")),
      /Set from\.apiToken/,
    );
    assert.throws(
      () => validateTokens(config("from-token", "PASTE_TO_ACCOUNT_API_TOKEN_HERE")),
      /Set to\.apiToken/,
    );
  });
});
