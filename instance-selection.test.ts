import { describe, expect, test } from "bun:test";
import { cloneLayout, CURRENT_CONFIG_VERSION, DEFAULT_LAYOUT, type AppConfig, type BrokerInstanceConfig , createDefaultConfig } from "gloomberb/types/config";
import {
  getConfiguredIbkrTradingInstances,
  getLockedIbkrTradingInstanceId,
  isIbkrCloudInstance,
  resolveIbkrTradingInstanceId,
} from "./instance-selection";

function createIbkrInstance(
  id: string,
  label: string,
  connectionMode: "flex" | "gateway" | "cloud",
  config: Record<string, unknown>,
): BrokerInstanceConfig {
  return {
    id,
    brokerType: "ibkr",
    label,
    connectionMode,
    config: { connectionMode, ...config },
    enabled: true,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  // Built from the host's defaults rather than a hand-listed literal: enumerating
  // every AppConfig field here breaks this plugin whenever the app adds one.
  return { ...createDefaultConfig("/tmp/gloomberb-ibkr-test"), ...overrides };
}

describe("IBKR trading instance selection", () => {
  test("returns no trading instance when only flex profiles exist", () => {
    const config = createConfig({
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
      ],
    });

    expect(resolveIbkrTradingInstanceId(config, "", "ibkr-default")).toBeUndefined();
  });

  test("prefers a gateway profile over a flex profile when both exist", () => {
    const config = createConfig({
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
      ],
    });

    expect(resolveIbkrTradingInstanceId(config, "", "ibkr-default")).toBe("ibkr-paper");
  });

  test("does not lock trading to a flex-backed portfolio", () => {
    const config = createConfig({
      portfolios: [{
        id: "broker:ibkr-default:DU12345",
        name: "DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-default",
        brokerAccountId: "DU12345",
      }],
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", {
          flex: { token: "token", queryId: "query" },
        }),
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
      ],
    });

    expect(getLockedIbkrTradingInstanceId(config, "broker:ibkr-default:DU12345")).toBeUndefined();
    expect(resolveIbkrTradingInstanceId(config, "broker:ibkr-default:DU12345")).toBe("ibkr-paper");
  });

  test("keeps trading locked to the active gateway-backed portfolio", () => {
    const config = createConfig({
      portfolios: [{
        id: "broker:ibkr-paper:DU12345",
        name: "DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-paper",
        brokerAccountId: "DU12345",
      }],
      brokerInstances: [
        createIbkrInstance("ibkr-paper", "Paper", "gateway", {
          gateway: { host: "127.0.0.1", port: 4002, clientId: 1 },
        }),
        createIbkrInstance("ibkr-live", "Live", "gateway", {
          gateway: { host: "127.0.0.1", port: 4001, clientId: 2 },
        }),
      ],
    });

    expect(getLockedIbkrTradingInstanceId(config, "broker:ibkr-paper:DU12345")).toBe("ibkr-paper");
    expect(resolveIbkrTradingInstanceId(config, "broker:ibkr-paper:DU12345", "ibkr-live")).toBe("ibkr-paper");
  });
});

describe("IBKR trading instance selection with sign-in profiles", () => {
  const cloudPortfolio = {
    id: "broker:ibkr-signin:U1234567",
    name: "U1234567",
    currency: "USD",
    brokerId: "ibkr",
    brokerInstanceId: "ibkr-signin",
    brokerAccountId: "U1234567",
  };

  test("lists Gateway and sign-in profiles as trading profiles, not Flex or disabled ones", () => {
    const config = createConfig({
      brokerInstances: [
        createIbkrInstance("ibkr-default", "IBKR", "flex", { flex: { token: "token", queryId: "query" } }),
        createIbkrInstance("ibkr-signin", "IBKR sign-in", "cloud", {}),
        { ...createIbkrInstance("ibkr-off", "Off", "cloud", {}), enabled: false },
        createIbkrInstance("ibkr-paper", "Paper", "gateway", { gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } }),
      ],
    });

    expect(getConfiguredIbkrTradingInstances(config).map((instance) => instance.id)).toEqual(["ibkr-signin", "ibkr-paper"]);
    expect(isIbkrCloudInstance(config.brokerInstances[1])).toBe(true);
    expect(isIbkrCloudInstance(config.brokerInstances[2])).toBe(false);
    expect(isIbkrCloudInstance(config.brokerInstances[3])).toBe(false);
  });

  test("ignores sign-in profiles unless asked to include them", () => {
    const config = createConfig({
      portfolios: [cloudPortfolio],
      brokerInstances: [createIbkrInstance("ibkr-signin", "IBKR sign-in", "cloud", {})],
    });

    expect(getLockedIbkrTradingInstanceId(config, cloudPortfolio.id)).toBeUndefined();
    expect(resolveIbkrTradingInstanceId(config, cloudPortfolio.id, "ibkr-signin")).toBeUndefined();
    expect(getLockedIbkrTradingInstanceId(config, cloudPortfolio.id, { includeCloud: true })).toBe("ibkr-signin");
    expect(resolveIbkrTradingInstanceId(config, "", undefined, { includeCloud: true })).toBe("ibkr-signin");
  });

  test("keeps Gateway ahead of sign-in when nothing else decides", () => {
    const config = createConfig({
      portfolios: [cloudPortfolio],
      brokerInstances: [
        createIbkrInstance("ibkr-signin", "IBKR sign-in", "cloud", {}),
        createIbkrInstance("ibkr-paper", "Paper", "gateway", { gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } }),
      ],
    });

    expect(resolveIbkrTradingInstanceId(config, "", undefined, { includeCloud: true })).toBe("ibkr-paper");
    expect(resolveIbkrTradingInstanceId(config, "", "ibkr-signin", { includeCloud: true })).toBe("ibkr-signin");
    expect(resolveIbkrTradingInstanceId(config, cloudPortfolio.id, "ibkr-paper", { includeCloud: true })).toBe("ibkr-signin");
  });
});
