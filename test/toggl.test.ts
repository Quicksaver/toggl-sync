import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TogglApiError, TogglClient } from "../src/toggl.js";

describe("TogglClient", () => {
  it("authenticates with token:api_token and accepts item envelopes", async () => {
    let request: Request | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ items: [{ id: 1, name: "Workspace" }] }), {
        status: 200,
      });
    };
    const client = new TogglClient("secret", "FROM ACCOUNT", "https://example.test", fakeFetch);

    assert.deepEqual(await client.getWorkspaces(), [{ id: 1, name: "Workspace" }]);
    assert.equal(
      request?.headers.get("authorization"),
      `Basic ${Buffer.from("secret:api_token").toString("base64")}`,
    );
  });

  it("surfaces the account, status, and response body on errors", async () => {
    const fakeFetch: typeof fetch = async () => new Response("invalid token", { status: 403 });
    const client = new TogglClient("bad", "TO ACCOUNT", "https://example.test", fakeFetch);

    await assert.rejects(client.getWorkspaces(), (error: unknown) => {
      if (!(error instanceof TogglApiError)) return false;
      assert.match(error.message, /TO ACCOUNT/);
      assert.match(error.message, /403/);
      assert.match(error.message, /invalid token/);
      return true;
    });
  });

  it("waits before the next request when quota headers reach zero", async () => {
    let requestCount = 0;
    const waits: number[] = [];
    const reports: Array<{ account: string; seconds: number }> = [];
    const fakeFetch: typeof fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers:
          requestCount === 1
            ? { "X-Toggl-Quota-Remaining": "0", "X-Toggl-Quota-Resets-In": "60" }
            : {},
      });
    };
    const client = new TogglClient(
      "secret",
      "TO ACCOUNT",
      "https://example.test",
      fakeFetch,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      (account, seconds) => reports.push({ account, seconds }),
    );

    await client.getWorkspaces();
    await client.getWorkspaces();

    assert.equal(requestCount, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0]! >= 60_000);
    assert.deepEqual(reports, [{ account: "TO ACCOUNT", seconds: 61 }]);
  });

  it("retries quota responses when Toggl supplies a reset interval", async () => {
    let requestCount = 0;
    const waits: number[] = [];
    const fakeFetch: typeof fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response("quota", {
          status: 429,
          headers: { "X-Toggl-Quota-Resets-In": "2" },
        });
      }
      return new Response(JSON.stringify([{ id: 1, name: "Workspace" }]), { status: 200 });
    };
    const client = new TogglClient(
      "secret",
      "FROM ACCOUNT",
      "https://example.test",
      fakeFetch,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      () => undefined,
    );

    assert.equal((await client.getWorkspaces())[0]?.id, 1);
    assert.deepEqual(waits, [3_000]);
    assert.equal(requestCount, 2);
  });
});
