import { cloudBrokerLink } from "gloomberb/broker";
import { openUrl } from "gloomberb/components";
import type { BrokerConnectionStatus } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import {
  cloudErrorKind,
  fetchIbkrCloudConnection,
  startIbkrCloudSignIn,
  type IbkrCloudConnectionState,
} from "./client";

/**
 * IBKR sign-in state for each profile on this device.
 *
 * The connection itself lives in the user's Gloom account and is shared by
 * every surface, so there is nothing to open or close here. What this module
 * owns is the local view of it: a status the Brokers pane can show, and the
 * browser sign-in that creates or renews the connection when it is missing.
 */

export const SIGNED_OUT_MESSAGE = "Sign in to your Gloom account first (ACM), then connect IBKR.";
const IDLE_MESSAGE = "Press Connect to sign in to IBKR";
const CONNECTED_MESSAGE = "Signed in to IBKR";
const EXPIRED_MESSAGE = "IBKR sign-in expired. Connect again.";
const TIMEOUT_MESSAGE = "IBKR sign-in timed out. Connect again to retry.";
const NOT_CONNECTED_MESSAGE = "IBKR is not signed in. Press Connect on this profile in Brokers.";
const EXPIRED_ACTION_MESSAGE = "IBKR sign-in expired. Press Connect on this profile in Brokers.";
const READ_ONLY_MESSAGE = "IBKR sign-in does not cover orders yet. Press Connect on this profile in Brokers.";

const POLL_INTERVAL_MS = 2_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export interface IbkrCloudConnectOptions {
  /** Require a grant that covers order instructions, not just reads. */
  write?: boolean;
  /** Start a browser sign-in when the connection is missing, rather than failing. */
  interactive?: boolean;
  /** How often to check whether the user finished signing in. */
  pollIntervalMs?: number;
  /** How long to wait for the user to finish signing in. */
  timeoutMs?: number;
}

interface SignInTiming {
  pollIntervalMs: number;
  timeoutMs: number;
}

let defaultTiming: SignInTiming = { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: SIGN_IN_TIMEOUT_MS };

/** Overrides the sign-in polling for callers that cannot pass options, such as the adapter under test. */
export function setIbkrCloudSignInTiming(timing: SignInTiming | null): void {
  defaultTiming = timing ?? { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: SIGN_IN_TIMEOUT_MS };
}

const statuses = new Map<string, BrokerConnectionStatus>();
const statusListeners = new Map<string, Set<() => void>>();

export function getIbkrCloudStatus(instanceId: string): BrokerConnectionStatus {
  return statuses.get(instanceId) ?? { state: "disconnected", mode: "cloud", message: IDLE_MESSAGE, updatedAt: 0 };
}

export function subscribeIbkrCloudStatus(instanceId: string, listener: () => void): () => void {
  let listeners = statusListeners.get(instanceId);
  if (!listeners) {
    listeners = new Set();
    statusListeners.set(instanceId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && statusListeners.get(instanceId) === listeners) statusListeners.delete(instanceId);
  };
}

function notify(instanceId: string): void {
  for (const listener of [...(statusListeners.get(instanceId) ?? [])]) listener();
}

function setStatus(instanceId: string, state: BrokerConnectionStatus["state"], message: string): void {
  const previous = statuses.get(instanceId);
  // Every successful sync reports "connected"; only a change is news.
  if (previous?.state === state && previous.message === message) return;
  statuses.set(instanceId, { state, mode: "cloud", message, updatedAt: Date.now() });
  notify(instanceId);
}

/** Drops a removed profile's local status. The shared connection stays as it is. */
export function forgetIbkrCloudStatus(instanceId: string): void {
  if (!statuses.delete(instanceId)) return;
  notify(instanceId);
}

/**
 * Opens a URL in the system browser without letting a missing opener fail the
 * caller: over SSH there may be no browser at all, which is why every URL this
 * mode opens is also shown to the user.
 */
export function openInBrowser(url: string): void {
  try {
    openUrl(url);
  } catch {
    // The URL is already visible in the status or on the order.
  }
}

/** Records what a failed request says about the connection. */
function noteFailure(instanceId: string, error: unknown): void {
  switch (cloudErrorKind(error)) {
    case "signed_out":
      setStatus(instanceId, "error", SIGNED_OUT_MESSAGE);
      break;
    case "not_connected":
      setStatus(instanceId, "disconnected", IDLE_MESSAGE);
      break;
    case "reauth_required":
      setStatus(instanceId, "error", EXPIRED_MESSAGE);
      break;
  }
}

/** Replaces the backend's connection errors with what the user should do next. */
function explain(error: unknown): unknown {
  switch (cloudErrorKind(error)) {
    case "signed_out": return new Error(SIGNED_OUT_MESSAGE);
    case "not_connected": return new Error(NOT_CONNECTED_MESSAGE);
    case "reauth_required": return new Error(EXPIRED_ACTION_MESSAGE);
    default: return error;
  }
}

async function track<T>(instanceId: string, load: () => Promise<T>): Promise<T> {
  try {
    const result = await load();
    setStatus(instanceId, "connected", CONNECTED_MESSAGE);
    return result;
  } catch (error) {
    noteFailure(instanceId, error);
    throw error;
  }
}

/**
 * Runs a request against the shared connection and keeps the profile's status
 * in step with what it learned. With `reconnect`, a missing or expired
 * connection sends the user through sign-in once and the request is retried
 * once.
 */
export async function withIbkrCloudConnection<T>(
  instance: BrokerInstanceConfig,
  load: () => Promise<T>,
  options: { reconnect?: boolean } = {},
): Promise<T> {
  try {
    return await track(instance.id, load);
  } catch (error) {
    const kind = cloudErrorKind(error);
    if (!options.reconnect || (kind !== "not_connected" && kind !== "reauth_required")) throw explain(error);
  }
  await ensureIbkrCloudConnection(instance, { interactive: true });
  try {
    return await track(instance.id, load);
  } catch (error) {
    throw explain(error);
  }
}

function isReady(connection: IbkrCloudConnectionState, write: boolean): boolean {
  return connection.connected && (!write || connection.canWrite);
}

/** Puts a failed attempt on the status and returns the error to throw. */
function failed(instanceId: string, message: string): Error {
  setStatus(instanceId, "error", message);
  return new Error(message);
}

function failedRequest(instanceId: string, error: unknown): unknown {
  if (cloudErrorKind(error) === "signed_out") return failed(instanceId, SIGNED_OUT_MESSAGE);
  setStatus(instanceId, "error", error instanceof Error ? error.message : String(error));
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResolvedConnectOptions {
  write: boolean;
  interactive: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

async function establish(instanceId: string, options: ResolvedConnectOptions): Promise<void> {
  if (!cloudBrokerLink.isSignedIn()) throw failed(instanceId, SIGNED_OUT_MESSAGE);

  const connection = await fetchIbkrCloudConnection().catch((error: unknown) => {
    throw failedRequest(instanceId, error);
  });
  if (isReady(connection, options.write)) {
    setStatus(instanceId, "connected", CONNECTED_MESSAGE);
    return;
  }

  if (!options.interactive) {
    if (connection.connected) {
      setStatus(instanceId, "connected", CONNECTED_MESSAGE);
      throw new Error(READ_ONLY_MESSAGE);
    }
    if (connection.status === "reauth_required") {
      setStatus(instanceId, "error", EXPIRED_MESSAGE);
      throw new Error(EXPIRED_ACTION_MESSAGE);
    }
    setStatus(instanceId, "disconnected", IDLE_MESSAGE);
    throw new Error(NOT_CONNECTED_MESSAGE);
  }

  // Always ask for trading: one sign-in then covers reads and order instructions.
  const signIn = await startIbkrCloudSignIn({ write: true }).catch((error: unknown) => {
    throw failedRequest(instanceId, error);
  });
  // The URL goes on the status before anything else: a terminal over SSH has
  // no browser to open, and the user copies it from there instead.
  setStatus(instanceId, "connecting", `Finish signing in to IBKR in your browser: ${signIn.authorizeUrl}`);
  openInBrowser(signIn.authorizeUrl);

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(options.pollIntervalMs, Math.max(0, deadline - Date.now())));
    const next = await fetchIbkrCloudConnection().catch((error: unknown) => {
      if (cloudErrorKind(error) === "signed_out") throw failed(instanceId, SIGNED_OUT_MESSAGE);
      // A blip while the user is still in the browser; the next check may land.
      return null;
    });
    if (next && isReady(next, options.write)) {
      setStatus(instanceId, "connected", CONNECTED_MESSAGE);
      return;
    }
  }
  throw failed(instanceId, TIMEOUT_MESSAGE);
}

interface SignInFlight {
  write: boolean;
  interactive: boolean;
  promise: Promise<void>;
}

const flights = new Map<string, SignInFlight>();

/**
 * Makes sure the shared connection is usable, signing the user in through the
 * browser when `interactive` allows it.
 *
 * One attempt runs per profile at a time: a sync, a Connect press and an order
 * that all find IBKR signed out share one sign-in instead of opening three
 * browser tabs. A caller that needs more than the running attempt asks for
 * (trading, or a sign-in where the attempt only checks) goes after it.
 */
export function ensureIbkrCloudConnection(
  instance: BrokerInstanceConfig,
  options: IbkrCloudConnectOptions = {},
): Promise<void> {
  const resolved: ResolvedConnectOptions = {
    write: options.write === true,
    interactive: options.interactive === true,
    pollIntervalMs: options.pollIntervalMs ?? defaultTiming.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? defaultTiming.timeoutMs,
  };
  const current = flights.get(instance.id);
  if (current && (current.write || !resolved.write) && (current.interactive || !resolved.interactive)) {
    return current.promise;
  }

  const previous = current ? current.promise.then(() => {}, () => {}) : Promise.resolve();
  const flight: SignInFlight = {
    write: resolved.write,
    interactive: resolved.interactive,
    promise: previous
      .then(() => establish(instance.id, resolved))
      .finally(() => {
        if (flights.get(instance.id) === flight) flights.delete(instance.id);
      }),
  };
  flights.set(instance.id, flight);
  return flight.promise;
}
