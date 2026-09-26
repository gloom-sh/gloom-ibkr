import { mock } from "bun:test";
import * as hostBroker from "gloomberb/broker";
import * as hostComponents from "gloomberb/components";
import type { IbkrCloudConnectionState } from "./client";

/**
 * A stand-in for the host's connection to the user's Gloom account, for tests
 * of IBKR sign-in.
 *
 * Module mocks are process-wide in bun, so they are installed once, here, and
 * every test file that imports this shares the same fake. Each test sets
 * `handler` for the responses it needs and calls `reset` between runs. The rest
 * of both host modules stays real, so tests that never touch sign-in are
 * unaffected.
 */

export interface FakeCloudCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}

export type FakeCloudHandler = (call: FakeCloudCall) => unknown;

function unhandled(call: FakeCloudCall): never {
  throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
}

export const fakeCloud = {
  signedIn: true,
  calls: [] as FakeCloudCall[],
  openedUrls: [] as string[],
  handler: unhandled as FakeCloudHandler,
  reset(): void {
    fakeCloud.signedIn = true;
    fakeCloud.calls = [];
    fakeCloud.openedUrls = [];
    fakeCloud.handler = unhandled;
  },
};

/** A failed request as the host reports it: an error carrying the HTTP status. */
export function cloudError(status: number, message = `Request failed with ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function connectionState(overrides: Partial<IbkrCloudConnectionState> = {}): IbkrCloudConnectionState {
  const connected = overrides.connected ?? false;
  return {
    connected,
    status: connected ? "connected" : "not_connected",
    scopes: connected ? ["mcp.read"] : [],
    canWrite: false,
    accountIds: connected ? ["U1234567"] : [],
    connectedAt: null,
    refreshedAt: null,
    syncedAt: null,
    ...overrides,
  };
}

mock.module("gloomberb/broker", () => ({
  ...hostBroker,
  cloudBrokerLink: {
    isSignedIn: () => fakeCloud.signedIn,
    request: async (
      _broker: string,
      path: string,
      options: { method?: FakeCloudCall["method"]; body?: unknown } = {},
    ) => {
      const call: FakeCloudCall = { method: options.method ?? "GET", path, body: options.body };
      fakeCloud.calls.push(call);
      return fakeCloud.handler(call);
    },
  },
}));

mock.module("gloomberb/components", () => ({
  ...hostComponents,
  openUrl: (url: string) => {
    fakeCloud.openedUrls.push(url);
  },
}));
