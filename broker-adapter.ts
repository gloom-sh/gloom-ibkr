import { cloudBrokerLink } from "gloomberb/broker";
import type { BrokerAdapter, BrokerPosition } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { BrokerOrder, BrokerOrderRequest } from "gloomberb/types/trading";
import {
  buildPersistedIbkrGatewayConfig,
  buildIbkrConfigFromValues,
  IBKR_CONFIG_FIELDS,
  isFlexConfigured,
  isGatewayConfigured,
  normalizeIbkrConfig,
  type FlexQueryConfig,
} from "./config";
import { getIbkrAccountCachePolicy, getIbkrAccountCacheSourceKey } from "./account-cache";
import { loadFlexStatement, parseFlexAccounts, parseFlexPositions } from "./flex";
import {
  GATEWAY_UNAVAILABLE_MESSAGE,
  gatewayServiceFor,
  gatewayUnavailableStatus,
  getIbkrGatewayBridge,
  requireGatewayBridge,
} from "./gateway-bridge";
import { getIbkrPortfolioPerformance } from "./portfolio-performance";
import {
  cloudErrorKind,
  createIbkrCloudInstruction,
  fetchIbkrCloudExecutions,
  fetchIbkrCloudOrders,
  fetchIbkrCloudPerformance,
  fetchIbkrCloudSnapshot,
} from "./cloud/client";
import {
  ensureIbkrCloudConnection,
  forgetIbkrCloudStatus,
  getIbkrCloudStatus,
  openInBrowser,
  subscribeIbkrCloudStatus,
  withIbkrCloudConnection,
} from "./cloud/connection";

async function importFlexPositions(config: FlexQueryConfig): Promise<BrokerPosition[]> {
  const xml = await loadFlexStatement(config);
  return parseFlexPositions(xml);
}

const CLOUD_CONSOLE_UNAVAILABLE_MESSAGE =
  "The IBKR Console needs a Gateway or TWS profile. Use the Trade tab to send orders to IBKR.";
const CLOUD_ORDER_TYPES_MESSAGE = "IBKR sign-in sends market and limit orders only.";
const CLOUD_MANAGED_ORDERS_MESSAGE = "Orders sent through IBKR sign-in are managed in IBKR.";

function loadCloudSnapshot(instance: BrokerInstanceConfig) {
  return withIbkrCloudConnection(instance, fetchIbkrCloudSnapshot, { reconnect: true });
}

/**
 * IBKR sign-in creates order instructions, which the user reviews and submits
 * in IBKR, and those only come as market or limit orders. Checking here keeps
 * an order IBKR would refuse from sending the user through a sign-in first.
 */
function validateCloudOrder(request: BrokerOrderRequest): void {
  if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
    throw new Error("Order quantity must be greater than zero.");
  }
  if (request.orderType !== "MKT" && request.orderType !== "LMT") {
    throw new Error(CLOUD_ORDER_TYPES_MESSAGE);
  }
  const limitPrice = request.limitPrice ?? Number.NaN;
  if (request.orderType === "LMT" && !(Number.isFinite(limitPrice) && limitPrice > 0)) {
    throw new Error("Limit orders need a positive limit price.");
  }
}

async function placeCloudOrder(instance: BrokerInstanceConfig, request: BrokerOrderRequest): Promise<BrokerOrder> {
  validateCloudOrder(request);
  await ensureIbkrCloudConnection(instance, { write: true, interactive: true });
  const send = () => withIbkrCloudConnection(instance, () => createIbkrCloudInstruction(request));
  const instruction = await send().catch(async (error: unknown) => {
    // The grant lost trading since the check above: sign in for it and try once more.
    if (cloudErrorKind(error) !== "write_not_granted") throw error;
    await ensureIbkrCloudConnection(instance, { write: true, interactive: true });
    return send();
  });
  openInBrowser(instruction.url);
  return {
    orderId: 0,
    brokerInstanceId: instance.id,
    accountId: request.accountId,
    status: "PendingReview",
    action: request.action,
    orderType: request.orderType,
    quantity: request.quantity,
    filled: 0,
    remaining: request.quantity,
    limitPrice: request.limitPrice,
    tif: request.tif,
    reviewUrl: instruction.url,
    warningText: "Review and submit this order in IBKR.",
    updatedAt: Date.now(),
    contract: request.contract,
  };
}

/** The backend does not know this device's profile ids; stamp them like Gateway does. */
function withInstanceId<T extends { brokerInstanceId?: string; contract: BrokerOrder["contract"] }>(
  instance: BrokerInstanceConfig,
  rows: T[],
): T[] {
  return rows.map((row) => ({
    ...row,
    brokerInstanceId: row.brokerInstanceId ?? instance.id,
    contract: { ...row.contract, brokerInstanceId: row.contract.brokerInstanceId ?? instance.id },
  }));
}

export const ibkrBroker: BrokerAdapter = {
  id: "ibkr",
  name: "Interactive Brokers",
  configSchema: IBKR_CONFIG_FIELDS,

  async validate(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") return cloudBrokerLink.isSignedIn();
    if (normalized.connectionMode !== "gateway") return isFlexConfigured(instance.config);
    // Without the Gateway plugin the profile is well-formed but unusable, so it
    // fails validation rather than silently importing nothing.
    return !!getIbkrGatewayBridge() && isGatewayConfigured(instance.config);
  },

  async importPositions(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") return (await loadCloudSnapshot(instance)).positions;
    if (normalized.connectionMode === "gateway") {
      const gateway = requireGatewayBridge();
      await gateway.refresh(instance);
      return gateway.getService(instance.id).getPositions(normalized.gateway);
    }
    return importFlexPositions(normalized.flex);
  },

  async importPortfolioSnapshot(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      const { accounts, positions } = await loadCloudSnapshot(instance);
      return { accounts, positions };
    }
    if (normalized.connectionMode === "gateway") {
      const gateway = requireGatewayBridge();
      await gateway.refresh(instance);
      const [accounts, positions] = await Promise.all([
        gateway.getService(instance.id).getAccounts(normalized.gateway),
        gateway.getService(instance.id).getPositions(normalized.gateway),
      ]);
      return { accounts, positions };
    }

    const xml = await loadFlexStatement(normalized.flex);
    return {
      accounts: parseFlexAccounts(xml),
      positions: parseFlexPositions(xml),
    };
  },

  async connect(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      await ensureIbkrCloudConnection(instance, { write: true, interactive: true });
      return;
    }
    if (normalized.connectionMode !== "gateway") return;
    await requireGatewayBridge().getService(instance.id).connect(normalized.gateway);
  },

  async disconnect(instance) {
    // IBKR sign-in is one grant shared by every Gloom surface, the user's agents
    // included, so a profile going away on this device never revokes it.
    if (normalizeIbkrConfig(instance.config).connectionMode === "cloud") forgetIbkrCloudStatus(instance.id);
    await getIbkrGatewayBridge()?.removeInstance(instance.id);
  },

  getStatus(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") return getIbkrCloudStatus(instance.id);
    if (normalized.connectionMode !== "gateway") {
      return {
        state: "disconnected",
        message: "Flex profiles sync on demand",
        mode: "flex",
        updatedAt: 0,
      };
    }
    const gateway = getIbkrGatewayBridge();
    if (!gateway) return { ...gatewayUnavailableStatus(), mode: "gateway" };
    return { ...gateway.getStatus(instance.id), mode: "gateway" };
  },

  subscribeStatus(instance, listener) {
    if (normalizeIbkrConfig(instance.config).connectionMode === "cloud") {
      return subscribeIbkrCloudStatus(instance.id, listener);
    }
    const gateway = getIbkrGatewayBridge();
    if (!gateway) return () => {};
    return gateway.subscribeStatus(instance.id, listener);
  },

  getPersistedConfigUpdate(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") return null;
    const resolved = gatewayServiceFor(instance.id)?.getResolvedConnection() ?? null;
    return resolved ? buildPersistedIbkrGatewayConfig(instance.config, resolved) : null;
  },

  getAccountCacheSourceKey: getIbkrAccountCacheSourceKey,
  getAccountCachePolicy: getIbkrAccountCachePolicy,

  getProfileActions(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      return [{
        id: "ibkr-console",
        label: "IBKR Console",
        paneId: "ibkr-trading",
        disabled: true,
        disabledReason: CLOUD_CONSOLE_UNAVAILABLE_MESSAGE,
      }];
    }
    return [{
      id: "ibkr-console",
      label: "IBKR Console",
      paneId: "ibkr-trading",
      disabled: normalized.connectionMode !== "gateway" || !getIbkrGatewayBridge(),
      disabledReason: getIbkrGatewayBridge()
        ? "IBKR Console is available for Gateway / TWS profiles."
        : GATEWAY_UNAVAILABLE_MESSAGE,
    }];
  },

  toConfigValues(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    return {
      connectionMode: normalized.connectionMode,
      token: normalized.flex.token,
      queryId: normalized.flex.queryId,
      endpoint: normalized.flex.endpoint,
      gatewaySetupMode: normalized.gatewaySetupMode,
      host: normalized.gateway.host,
      port: normalized.gateway.port,
      clientId: normalized.gateway.clientId,
      marketDataType: normalized.gateway.marketDataType,
    };
  },

  fromConfigValues(values, previous) {
    const next = buildIbkrConfigFromValues(values);
    const previousConfig = previous ? normalizeIbkrConfig(previous.config) : null;
    if (!previousConfig || next.connectionMode !== "gateway") return next as unknown as Record<string, unknown>;

    return {
      ...next,
      gateway: {
        ...next.gateway,
        marketDataType: next.gateway.marketDataType ?? previousConfig.gateway.marketDataType,
        lastSuccessfulPort: previousConfig.gateway.lastSuccessfulPort,
        lastSuccessfulClientId: previousConfig.gateway.lastSuccessfulClientId,
      },
    } as unknown as Record<string, unknown>;
  },

  async listAccounts(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") return (await loadCloudSnapshot(instance)).accounts;
    if (normalized.connectionMode === "gateway") {
      return requireGatewayBridge().getService(instance.id).getAccounts(normalized.gateway);
    }
    const xml = await loadFlexStatement(normalized.flex);
    return parseFlexAccounts(xml);
  },

  async getPortfolioPerformance(instance, accountId) {
    if (normalizeIbkrConfig(instance.config).connectionMode === "cloud") {
      return withIbkrCloudConnection(instance, () => fetchIbkrCloudPerformance(accountId));
    }
    return getIbkrPortfolioPerformance(instance, accountId);
  },

  async searchInstruments(query, instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") return [];
    return (await requireGatewayBridge().getService(instance.id).searchInstruments(query, normalized.gateway)).map((result) => ({
      ...result,
      brokerInstanceId: result.brokerInstanceId ?? instance.id,
      brokerLabel: result.brokerLabel ?? instance.label,
      brokerContract: result.brokerContract
        ? { ...result.brokerContract, brokerInstanceId: result.brokerContract.brokerInstanceId ?? instance.id }
        : undefined,
    }));
  },

  async getTickerFinancials(ticker, instance, exchange, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker market data");
    }
    return requireGatewayBridge().getService(instance.id).getTickerFinancials(ticker, normalized.gateway, exchange, instrument);
  },

  async getQuote(ticker, instance, exchange, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker quotes");
    }
    return requireGatewayBridge().getService(instance.id).getQuote(ticker, normalized.gateway, exchange, instrument);
  },

  async getPriceHistory(ticker, instance, exchange, range, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker history");
    }
    return requireGatewayBridge().getService(instance.id).getPriceHistory(ticker, normalized.gateway, exchange, range, instrument);
  },

  getChartResolutionSupport(ticker, instance, exchange, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker history");
    }
    return requireGatewayBridge().getService(instance.id).getChartResolutionSupport(
      ticker,
      normalized.gateway,
      exchange,
      instrument,
    );
  },

  async getPriceHistoryForResolution(ticker, instance, exchange, bufferRange, resolution, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker history");
    }
    return requireGatewayBridge().getService(instance.id).getPriceHistoryForResolution(
      ticker,
      normalized.gateway,
      exchange,
      bufferRange,
      resolution,
      instrument,
    );
  },

  async getDetailedPriceHistory(ticker, instance, exchange, startDate, endDate, barSize, instrument) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for broker history");
    }
    return requireGatewayBridge().getService(instance.id).getDetailedPriceHistory(
      ticker,
      normalized.gateway,
      exchange,
      startDate,
      endDate,
      barSize,
      instrument,
    );
  },

  // Sign-in reports "connected" yet has no quote stream; without this the host
  // would route quotes here and wake the profile, sending the user to sign in.
  canStreamQuotes(instance) {
    return normalizeIbkrConfig(instance.config).connectionMode !== "cloud";
  },

  subscribeQuotes(instance, targets, onQuote) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode !== "gateway") {
      return () => {};
    }
    return requireGatewayBridge().getService(instance.id).subscribeQuotes(normalized.gateway, targets, onQuote);
  },

  async listOpenOrders(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      return withInstanceId(instance, await withIbkrCloudConnection(instance, fetchIbkrCloudOrders));
    }
    if (normalized.connectionMode !== "gateway") return [];
    return requireGatewayBridge().getService(instance.id).listOpenOrders(normalized.gateway);
  },

  async listExecutions(instance) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      return withInstanceId(instance, await withIbkrCloudConnection(instance, () => fetchIbkrCloudExecutions("DAYS_90")));
    }
    if (normalized.connectionMode !== "gateway") return [];
    return requireGatewayBridge().getService(instance.id).listExecutions(normalized.gateway);
  },

  async previewOrder(instance, request) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") {
      validateCloudOrder(request);
      return { warningText: "IBKR will open this order for you to review and submit." };
    }
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for order preview");
    }
    return requireGatewayBridge().getService(instance.id).previewOrder(normalized.gateway, request);
  },

  async placeOrder(instance, request) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") return placeCloudOrder(instance, request);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for trading");
    }
    return requireGatewayBridge().getService(instance.id).placeOrder(normalized.gateway, request);
  },

  async modifyOrder(instance, orderId, request) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") throw new Error(CLOUD_MANAGED_ORDERS_MESSAGE);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for trading");
    }
    return requireGatewayBridge().getService(instance.id).modifyOrder(normalized.gateway, orderId, request);
  },

  async cancelOrder(instance, orderId) {
    const normalized = normalizeIbkrConfig(instance.config);
    if (normalized.connectionMode === "cloud") throw new Error(CLOUD_MANAGED_ORDERS_MESSAGE);
    if (normalized.connectionMode !== "gateway") {
      throw new Error("Gateway mode is required for trading");
    }
    return requireGatewayBridge().getService(instance.id).cancelOrder(normalized.gateway, orderId);
  },
};
