import type { BrokerConnectionStatus, BrokerPosition } from "gloomberb/types/broker";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
  BrokerOrderPreview,
  BrokerOrderRequest,
} from "gloomberb/types/trading";
import type { BrokerContractRef, InstrumentSearchResult } from "gloomberb/types/instrument";
import type { QuoteSubscriptionTarget } from "gloomberb/types/data-provider";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { Quote, TickerFinancials, PricePoint } from "gloomberb/types/financials";
import type { ChartResolutionSupport, ManualChartResolution } from "gloomberb/time-series";
import type { TimeRange } from "gloomberb/time-series";
import type { IbkrGatewayConfig, IbkrSnapshot, ResolvedIbkrGatewayConnection } from "./gateway-types";

/**
 * The seam between IBKR Flex and IBKR Gateway.
 *
 * Flex talks to a hosted HTTPS statement service and runs anywhere. Gateway
 * opens a raw TCP socket to a local TWS instance, so it can never run in a
 * browser. They are separate plugins for that reason, but they are one broker:
 * a user has a single "Interactive Brokers" profile whose `connectionMode`
 * decides which side services it.
 *
 * Splitting them across two broker ids would orphan every saved broker instance
 * and its stored credentials, so instead the Flex plugin owns the broker id and
 * Gateway registers itself here when installed. With no Gateway plugin present,
 * a Gateway-mode profile reports why it is inert rather than failing obscurely.
 *
 * The bridge hands back the gateway service rather than mirroring its ~20
 * methods: the adapter's gateway calls stay exactly as they were, and the two
 * plugins share one type instead of a hand-copied interface that drifts.
 */

export interface IbkrGatewayBridge {
  refresh(instance: BrokerInstanceConfig): Promise<void>;
  getService(instanceId: string): IbkrGatewayServiceFacade;
  removeInstance(instanceId: string): Promise<void>;
  getStatus(instanceId: string): BrokerConnectionStatus;
  subscribeStatus(instanceId: string, listener: () => void): () => void;
}

/**
 * The bridge lives on `globalThis`, not in a module variable.
 *
 * In the terminal both plugins resolve this file to one module, so a variable
 * would do. The desktop view compiles each plugin into its own bundle, and a
 * sibling import is copied into the bundle that imports it: Gateway would set
 * the bridge in its copy while Flex read its own, still null, and offer to
 * install a plugin that is already running. One process-wide slot is what
 * "Gateway registers itself with Flex" actually means.
 */
const BRIDGE_SLOT = Symbol.for("gloom-ibkr.gateway-bridge");

function slot(): { bridge: IbkrGatewayBridge | null } {
  const globals = globalThis as { [BRIDGE_SLOT]?: { bridge: IbkrGatewayBridge | null } };
  return (globals[BRIDGE_SLOT] ??= { bridge: null });
}

export function setIbkrGatewayBridge(next: IbkrGatewayBridge | null): void {
  slot().bridge = next;
}

export function getIbkrGatewayBridge(): IbkrGatewayBridge | null {
  return slot().bridge;
}

export const GATEWAY_UNAVAILABLE_MESSAGE =
  "Install the IBKR Gateway plugin to use a Gateway or TWS profile.";

/** Status shown for a Gateway profile when the Gateway plugin is not installed. */
export function gatewayUnavailableStatus(): BrokerConnectionStatus {
  return {
    state: "error",
    message: GATEWAY_UNAVAILABLE_MESSAGE,
    updatedAt: Date.now(),
  };
}

export function requireGatewayBridge(): IbkrGatewayBridge {
  const bridge = getIbkrGatewayBridge();
  if (!bridge) throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
  return bridge;
}

/** The gateway service for an instance, or `null` when Gateway is not installed. */
export function gatewayServiceFor(instanceId: string): IbkrGatewayServiceFacade | null {
  return getIbkrGatewayBridge()?.getService(instanceId) ?? null;
}

/**
 * What the Flex adapter calls on a Gateway service.
 *
 * The interface lives here, not in the Gateway plugin, so the dependency runs
 * one way: Gateway extends Flex, imports this, and implements it. Putting it on
 * the Gateway side would make the two plugins depend on each other.
 */
export interface IbkrGatewayServiceFacade {
  getSnapshot(): IbkrSnapshot;
  getResolvedConnection(): ResolvedIbkrGatewayConnection | null;
  subscribe(listener: () => void): () => void;
  connect(config: IbkrGatewayConfig): Promise<void>;
  disconnect(): Promise<void>;
  getAccounts(config: IbkrGatewayConfig): Promise<BrokerAccount[]>;
  getPositions(config: IbkrGatewayConfig): Promise<BrokerPosition[]>;
  listOpenOrders(config: IbkrGatewayConfig): Promise<BrokerOrder[]>;
  listExecutions(config: IbkrGatewayConfig): Promise<BrokerExecution[]>;
  searchInstruments(query: string, config: IbkrGatewayConfig): Promise<InstrumentSearchResult[]>;
  getTickerFinancials(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange?: string,
    instrument?: BrokerContractRef | null,
  ): Promise<TickerFinancials>;
  getQuote(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange?: string,
    instrument?: BrokerContractRef | null,
  ): Promise<Quote>;
  getPriceHistory(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    range: TimeRange,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]>;
  getChartResolutionSupport(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange?: string,
    instrument?: BrokerContractRef | null,
  ): Promise<ChartResolutionSupport[]> | ChartResolutionSupport[];
  getPriceHistoryForResolution(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]>;
  getDetailedPriceHistory(
    ticker: string,
    config: IbkrGatewayConfig,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    instrument?: BrokerContractRef | null,
  ): Promise<PricePoint[]>;
  previewOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrderPreview>;
  placeOrder(config: IbkrGatewayConfig, request: BrokerOrderRequest): Promise<BrokerOrder>;
  modifyOrder(config: IbkrGatewayConfig, orderId: number, request: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder(config: IbkrGatewayConfig, orderId: number): Promise<void>;
  subscribeQuotes(
    config: IbkrGatewayConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void;
}
