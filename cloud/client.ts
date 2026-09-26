import { cloudBrokerLink } from "gloomberb/broker";
import type { BrokerPosition } from "gloomberb/types/broker";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPortfolioPerformance,
} from "gloomberb/types/trading";

/**
 * The IBKR sign-in endpoints, reached through the user's Gloom account.
 *
 * IBKR keeps one API connection per user, so the account holds it and every
 * Gloom surface shares it. This device never talks to IBKR in this mode: each
 * call below is a request to `/brokers/ibkr` with the Gloom session, and the
 * payloads already arrive in the host's broker shapes.
 */

const BROKER_ID = "ibkr";

export interface IbkrCloudConnectionState {
  connected: boolean;
  status: "connected" | "reauth_required" | "not_connected";
  scopes: string[];
  /** Whether the grant covers order instructions, not just reads. */
  canWrite: boolean;
  accountIds: string[];
  connectedAt: string | null;
  refreshedAt: string | null;
  syncedAt: string | null;
}

export interface IbkrCloudSignIn {
  /** Where the user signs in to IBKR; the backend completes the connection itself. */
  authorizeUrl: string;
  expiresAt: string;
}

export interface IbkrCloudSnapshot {
  accounts: BrokerAccount[];
  positions: BrokerPosition[];
  fetchedAt: number;
}

/** An order the user still reviews and submits in IBKR, not a live order. */
export interface IbkrCloudOrderInstruction {
  id: string;
  url?: string;
  symbol?: string;
  description?: string;
  contractIdEx?: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  limitPrice?: number;
  tif?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface IbkrCloudInstructionLink {
  id: string;
  /** Opens the instruction in IBKR, where the user reviews and submits it. */
  url: string;
}

export type IbkrCloudErrorKind =
  | "signed_out"
  | "not_connected"
  | "reauth_required"
  | "write_not_granted"
  | "unsupported"
  | "unavailable"
  | "other";

/** What a failed request means, read from the HTTP status the host attaches. */
export function cloudErrorKind(error: unknown): IbkrCloudErrorKind {
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  switch (status) {
    case 401: return "signed_out";
    case 403: return "write_not_granted";
    case 404: return "not_connected";
    case 409: return "reauth_required";
    case 422: return "unsupported";
    case 502:
    case 503:
    case 504: return "unavailable";
    default: return "other";
  }
}

function request<T>(
  path: string,
  options?: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  return cloudBrokerLink.request<T>(BROKER_ID, path, options);
}

export function fetchIbkrCloudConnection(signal?: AbortSignal): Promise<IbkrCloudConnectionState> {
  return request("", { signal });
}

export function startIbkrCloudSignIn(options: { write: boolean }): Promise<IbkrCloudSignIn> {
  return request("/connect", { method: "POST", body: { write: options.write } });
}

/**
 * Revokes the IBKR grant for every Gloom surface, the user's agents included.
 * Removing a profile on this device must never call it.
 */
export function revokeIbkrCloudConnection(): Promise<{ disconnected: boolean }> {
  return request("", { method: "DELETE" });
}

export function fetchIbkrCloudSnapshot(): Promise<IbkrCloudSnapshot> {
  return request("/snapshot");
}

export function fetchIbkrCloudPerformance(accountId: string): Promise<BrokerPortfolioPerformance | null> {
  return request(`/performance?accountId=${encodeURIComponent(accountId)}`);
}

export function fetchIbkrCloudExecutions(period = "DAYS_90"): Promise<BrokerExecution[]> {
  return request(`/executions?period=${encodeURIComponent(period)}`);
}

export function fetchIbkrCloudOrders(): Promise<BrokerOrder[]> {
  return request("/orders");
}

export function fetchIbkrCloudInstructions(): Promise<IbkrCloudOrderInstruction[]> {
  return request("/instructions");
}

/**
 * The instance ids are local to this device, so they stay out of the body:
 * the backend only needs the IBKR contract and the order itself.
 */
export function createIbkrCloudInstruction(order: BrokerOrderRequest): Promise<IbkrCloudInstructionLink> {
  const { brokerInstanceId: _instanceId, contract, ...rest } = order;
  const { brokerInstanceId: _contractInstanceId, ...ibkrContract } = contract;
  return request("/instructions", { method: "POST", body: { ...rest, contract: ibkrContract } });
}

export function deleteIbkrCloudInstruction(id: string): Promise<{ deleted: boolean }> {
  return request(`/instructions/${encodeURIComponent(id)}`, { method: "DELETE" });
}
