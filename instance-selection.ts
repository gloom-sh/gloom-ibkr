import type { AppConfig, BrokerInstanceConfig } from "gloomberb/types/config";
import { getBrokerInstance, getBrokerInstancesByType } from "gloomberb/utils";
import { isGatewayConfigured, normalizeIbkrConfig } from "./config";

export interface IbkrTradingSelectionOptions {
  /**
   * Also accept IBKR sign-in profiles, whose orders open in IBKR for review.
   * Off by default, since callers written for Gateway expect a live session.
   */
  includeCloud?: boolean;
}

function isIbkrGatewayInstance(instance?: BrokerInstanceConfig): instance is BrokerInstanceConfig {
  if (!instance || instance.brokerType !== "ibkr" || instance.enabled === false) return false;
  const normalized = normalizeIbkrConfig(instance.config);
  return normalized.connectionMode === "gateway" && isGatewayConfigured(instance.config);
}

export function isIbkrCloudInstance(instance?: BrokerInstanceConfig): instance is BrokerInstanceConfig {
  if (!instance || instance.brokerType !== "ibkr" || instance.enabled === false) return false;
  return normalizeIbkrConfig(instance.config).connectionMode === "cloud";
}

function isIbkrTradingInstance(
  instance: BrokerInstanceConfig | undefined,
  options: IbkrTradingSelectionOptions,
): instance is BrokerInstanceConfig {
  return isIbkrGatewayInstance(instance) || (options.includeCloud === true && isIbkrCloudInstance(instance));
}

export function getConfiguredIbkrGatewayInstances(config: AppConfig): BrokerInstanceConfig[] {
  return getBrokerInstancesByType(config.brokerInstances, "ibkr").filter(isIbkrGatewayInstance);
}

/** Every profile that can send orders: Gateway sessions and IBKR sign-in. */
export function getConfiguredIbkrTradingInstances(config: AppConfig): BrokerInstanceConfig[] {
  return getBrokerInstancesByType(config.brokerInstances, "ibkr")
    .filter((instance) => isIbkrTradingInstance(instance, { includeCloud: true }));
}

export function getLockedIbkrTradingInstanceId(
  config: AppConfig,
  collectionId: string | null,
  options: IbkrTradingSelectionOptions = {},
): string | undefined {
  const activePortfolio = config.portfolios.find((portfolio) => portfolio.id === collectionId);
  if (activePortfolio?.brokerId !== "ibkr" || !activePortfolio.brokerInstanceId) return undefined;
  const instance = getBrokerInstance(config.brokerInstances, activePortfolio.brokerInstanceId);
  return isIbkrTradingInstance(instance, options) ? instance.id : undefined;
}

export function resolveIbkrTradingInstanceId(
  config: AppConfig,
  collectionId: string | null,
  preferredInstanceId?: string,
  options: IbkrTradingSelectionOptions = {},
): string | undefined {
  const lockedInstanceId = getLockedIbkrTradingInstanceId(config, collectionId, options);
  if (lockedInstanceId) return lockedInstanceId;

  const preferredInstance = getBrokerInstance(config.brokerInstances, preferredInstanceId);
  if (isIbkrTradingInstance(preferredInstance, options)) return preferredInstance.id;

  const gatewayInstance = getConfiguredIbkrGatewayInstances(config)[0];
  if (gatewayInstance) return gatewayInstance.id;
  // A live Gateway session wins when nothing else decides; sign-in comes next.
  if (options.includeCloud) {
    return getBrokerInstancesByType(config.brokerInstances, "ibkr").find(isIbkrCloudInstance)?.id;
  }
  return undefined;
}
