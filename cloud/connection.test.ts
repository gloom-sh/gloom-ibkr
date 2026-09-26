import { cloudError, connectionState, fakeCloud, type FakeCloudCall } from "./test-support";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BrokerConnectionStatus } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import {
  ensureIbkrCloudConnection,
  getIbkrCloudStatus,
  SIGNED_OUT_MESSAGE,
  subscribeIbkrCloudStatus,
} from "./connection";

const AUTHORIZE_URL = "https://www.interactivebrokers.com/authorize?state=abc";
const FAST = { pollIntervalMs: 5, timeoutMs: 1_000 };

let nextId = 0;

// Status and in-flight sign-ins are kept per profile id, so each test gets its own.
function cloudInstance(): BrokerInstanceConfig {
  nextId += 1;
  return {
    id: `ibkr-cloud-${nextId}`,
    brokerType: "ibkr",
    label: "IBKR",
    connectionMode: "cloud",
    config: { connectionMode: "cloud" },
    enabled: true,
  };
}

/** Answers status checks from `states` in order, repeating the last one. */
function signInBackend(states: ReturnType<typeof connectionState>[]) {
  let checks = 0;
  return (call: FakeCloudCall) => {
    if (call.method === "GET" && call.path === "") {
      const state = states[Math.min(checks, states.length - 1)];
      checks += 1;
      return state;
    }
    if (call.method === "POST" && call.path === "/connect") {
      return { authorizeUrl: AUTHORIZE_URL, expiresAt: "2026-09-26T12:15:00.000Z" };
    }
    throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
  };
}

function recordStatuses(instance: BrokerInstanceConfig): { statuses: BrokerConnectionStatus[]; stop: () => void } {
  const statuses: BrokerConnectionStatus[] = [];
  const stop = subscribeIbkrCloudStatus(instance.id, () => statuses.push(getIbkrCloudStatus(instance.id)));
  return { statuses, stop };
}

beforeEach(() => {
  fakeCloud.reset();
});

afterEach(() => {
  fakeCloud.reset();
});

describe("IBKR sign-in connection", () => {
  test("an existing connection with trading is used as is", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([connectionState({ connected: true, canWrite: true })]);

    await ensureIbkrCloudConnection(instance, { write: true, interactive: true, ...FAST });

    expect(fakeCloud.calls).toEqual([{ method: "GET", path: "", body: undefined }]);
    expect(fakeCloud.openedUrls).toEqual([]);
    expect(getIbkrCloudStatus(instance.id)).toMatchObject({
      state: "connected",
      mode: "cloud",
      message: "Signed in to IBKR",
    });
  });

  test("signs in through the browser, shows the URL, and waits for the connection", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([
      connectionState(),
      connectionState(),
      connectionState({ connected: true, canWrite: true }),
    ]);
    const { statuses, stop } = recordStatuses(instance);

    await ensureIbkrCloudConnection(instance, { write: true, interactive: true, ...FAST });
    stop();

    expect(fakeCloud.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/connect", body: { write: true } },
    ]);
    expect(fakeCloud.openedUrls).toEqual([AUTHORIZE_URL]);
    // Over SSH there is no browser to open, so the URL has to be on screen.
    expect(statuses[0]).toMatchObject({
      state: "connecting",
      mode: "cloud",
      message: `Finish signing in to IBKR in your browser: ${AUTHORIZE_URL}`,
    });
    expect(statuses.at(-1)).toMatchObject({ state: "connected", message: "Signed in to IBKR" });
    expect(fakeCloud.calls.filter((call) => call.method === "GET")).toHaveLength(3);
  });

  test("asks for trading even when the caller only needs to read", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([connectionState(), connectionState({ connected: true })]);

    await ensureIbkrCloudConnection(instance, { interactive: true, ...FAST });

    expect(fakeCloud.calls.find((call) => call.path === "/connect")?.body).toEqual({ write: true });
  });

  test("a read-only connection is not enough when trading is required", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([
      connectionState({ connected: true }),
      connectionState({ connected: true }),
      connectionState({ connected: true, canWrite: true }),
    ]);

    await ensureIbkrCloudConnection(instance, { write: true, interactive: true, ...FAST });

    expect(fakeCloud.openedUrls).toEqual([AUTHORIZE_URL]);
    expect(fakeCloud.calls.filter((call) => call.method === "GET")).toHaveLength(3);
  });

  test("concurrent callers share one sign-in", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([
      connectionState(),
      connectionState(),
      connectionState({ connected: true, canWrite: true }),
    ]);

    await Promise.all([
      ensureIbkrCloudConnection(instance, { write: true, interactive: true, ...FAST }),
      ensureIbkrCloudConnection(instance, { write: true, interactive: true, ...FAST }),
      ensureIbkrCloudConnection(instance, { interactive: true, ...FAST }),
    ]);

    expect(fakeCloud.calls.filter((call) => call.path === "/connect")).toHaveLength(1);
    expect(fakeCloud.openedUrls).toEqual([AUTHORIZE_URL]);
  });

  test("gives up when the user never finishes signing in", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([connectionState()]);

    await expect(ensureIbkrCloudConnection(instance, { interactive: true, pollIntervalMs: 5, timeoutMs: 30 }))
      .rejects.toThrow("IBKR sign-in timed out. Connect again to retry.");
    expect(getIbkrCloudStatus(instance.id)).toMatchObject({
      state: "error",
      mode: "cloud",
      message: "IBKR sign-in timed out. Connect again to retry.",
    });
    // A later attempt starts over rather than joining the failed one.
    fakeCloud.handler = signInBackend([connectionState({ connected: true, canWrite: true })]);
    await ensureIbkrCloudConnection(instance, { interactive: true, ...FAST });
    expect(getIbkrCloudStatus(instance.id).state).toBe("connected");
  });

  test("keeps waiting through a failed status check", async () => {
    const instance = cloudInstance();
    let checks = 0;
    fakeCloud.handler = (call) => {
      if (call.path === "/connect") return { authorizeUrl: AUTHORIZE_URL, expiresAt: "" };
      checks += 1;
      if (checks === 2) throw cloudError(502);
      return checks === 1 ? connectionState() : connectionState({ connected: true, canWrite: true });
    };

    await ensureIbkrCloudConnection(instance, { interactive: true, ...FAST });

    expect(getIbkrCloudStatus(instance.id).state).toBe("connected");
  });

  test("without a Gloom session it asks the user to sign in to Gloom first", async () => {
    const instance = cloudInstance();
    fakeCloud.signedIn = false;

    await expect(ensureIbkrCloudConnection(instance, { interactive: true, ...FAST }))
      .rejects.toThrow(SIGNED_OUT_MESSAGE);
    expect(fakeCloud.calls).toEqual([]);

    fakeCloud.signedIn = true;
    fakeCloud.handler = () => {
      throw cloudError(401);
    };
    await expect(ensureIbkrCloudConnection(instance, { interactive: true, ...FAST }))
      .rejects.toThrow(SIGNED_OUT_MESSAGE);
  });

  test("a non-interactive check points at Connect instead of opening a browser", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([connectionState()]);

    await expect(ensureIbkrCloudConnection(instance, { ...FAST })).rejects.toThrow(/Press Connect.*in Brokers/);
    expect(fakeCloud.calls.map((call) => call.path)).toEqual([""]);
    expect(fakeCloud.openedUrls).toEqual([]);
  });

  test("reports an expired sign-in on the status", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = signInBackend([connectionState({ status: "reauth_required" })]);

    await expect(ensureIbkrCloudConnection(instance, { ...FAST })).rejects.toThrow("IBKR sign-in expired");
    expect(getIbkrCloudStatus(instance.id)).toMatchObject({
      state: "error",
      mode: "cloud",
      message: "IBKR sign-in expired. Connect again.",
    });
  });
});
