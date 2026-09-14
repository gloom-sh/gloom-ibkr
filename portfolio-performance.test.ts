import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { BrokerPortfolioPerformance } from "gloomberb/types/trading";
import { AppPersistence } from "gloomberb/test-support";
import { fnv1aHashString } from "gloomberb/utils";
import { normalizeIbkrConfig } from "./config";
import {
  getIbkrPortfolioPerformance,
  setIbkrPortfolioPerformanceResourceStore,
} from "./portfolio-performance";

function createGatewayInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-live",
    brokerType: "ibkr",
    label: "IBKR Live",
    connectionMode: "gateway",
    enabled: true,
    config: {
      connectionMode: "gateway",
      gateway: { host: "127.0.0.1", port: 4001, clientId: 1 },
    },
  };
}

afterEach(() => {
  setIbkrPortfolioPerformanceResourceStore(null);
});

describe("getIbkrPortfolioPerformance", () => {
  test("uses Flex only for historical portfolio performance", async () => {
    const performance = await getIbkrPortfolioPerformance(createGatewayInstance(), "U12345");

    expect(performance).toBeNull();
  });

  test("discards unverifiable legacy history from fresh, expired, and other-source caches", async () => {
    const persistence = new AppPersistence(":memory:");
    setIbkrPortfolioPerformanceResourceStore(persistence.resources);
    const instance = createGatewayInstance();
    const config = normalizeIbkrConfig(instance.config);
    const sourceKey = fnv1aHashString(JSON.stringify({
      connectionMode: config.connectionMode,
      flexQueryId: config.flex.queryId,
      flexEndpoint: config.flex.endpoint,
    }));
    const performance: BrokerPortfolioPerformance = {
      accountId: "U222", source: "flex", period: "FLEX", fetchedAt: 1,
      points: [{ date: "2026-09-01", value: 10000 }],
    };
    const key = { namespace: "plugin:ibkr", kind: "portfolio-performance", entityKey: `${instance.id}:U222` };
    try {
      for (const cachedSource of [sourceKey, "previous-query"]) {
        for (const age of [0, 10_000]) {
          persistence.resources.set({ ...key, sourceKey: cachedSource }, performance, {
            schemaVersion: 1, fetchedAt: Date.now() - age, cachePolicy: { staleMs: 1000, expireMs: 2000 },
          });
          expect(await getIbkrPortfolioPerformance(instance, "U222")).toBeNull();
          expect(persistence.resources.list(key, { allowExpired: true })).toHaveLength(0);
        }
      }
    } finally {
      persistence.close();
    }
  });

  test("retains verified current-schema history through fresh hits and stale fallback", async () => {
    const persistence = new AppPersistence(":memory:");
    setIbkrPortfolioPerformanceResourceStore(persistence.resources);
    const instance = createGatewayInstance();
    const config = normalizeIbkrConfig(instance.config);
    const sourceKey = fnv1aHashString(JSON.stringify({
      connectionMode: config.connectionMode,
      flexQueryId: config.flex.queryId,
      flexEndpoint: config.flex.endpoint,
    }));
    const performance: BrokerPortfolioPerformance = {
      accountId: "U222", source: "flex", period: "FLEX", currency: "USD", fetchedAt: 1,
      points: [{ date: "2026-09-01", value: 10000, cumulativeReturn: 0 }],
    };
    const key = { namespace: "plugin:ibkr", kind: "portfolio-performance", entityKey: `${instance.id}:U222`, sourceKey };
    try {
      for (const age of [0, 2000, 10_000]) {
        persistence.resources.set(key, performance, {
          schemaVersion: 2, fetchedAt: Date.now() - age, cachePolicy: { staleMs: 1000, expireMs: 5000 },
        });
        expect(await getIbkrPortfolioPerformance(instance, "U222")).toEqual({ ...performance, stale: age > 0 });
      }
    } finally {
      persistence.close();
    }
  });
});
