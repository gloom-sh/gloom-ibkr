import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "gloomberb/test-support";
import { fnv1aHashString, setHttpFetchTransport } from "gloomberb/utils";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { BrokerPortfolioPerformance } from "gloomberb/types/trading";
import { normalizeIbkrConfig } from "./config";
import { getIbkrPortfolioPerformance, setIbkrPortfolioPerformanceResourceStore } from "./portfolio-performance";

let persistence: AppPersistence | undefined;
afterEach(() => { setHttpFetchTransport(null); setIbkrPortfolioPerformanceResourceStore(null); persistence?.close(); persistence = undefined; });
const instance: BrokerInstanceConfig = { id: "return-units", brokerType: "ibkr", label: "Controlled", enabled: true,
  config: { connectionMode: "flex", flex: { token: "CONTROLLED", queryId: "return-units" } } };
const normalized = normalizeIbkrConfig(instance.config);
const sourceKey = fnv1aHashString(JSON.stringify({ connectionMode: normalized.connectionMode, flexQueryId: normalized.flex.queryId, flexEndpoint: normalized.flex.endpoint }));
const key = { namespace: "plugin:ibkr", kind: "portfolio-performance", entityKey: `${instance.id}:CONTROLLED` };
const history: BrokerPortfolioPerformance = { accountId: "CONTROLLED", source: "flex", period: "FLEX", currency: "USD", fetchedAt: 1,
  points: [{ date: "2026-09-01", value: 10000, cumulativeReturn: 0 }, { date: "2026-09-02", value: 21000, cumulativeReturn: 1 }] };

test("schema-one guessed returns cannot return through matching or cross-source cache fallbacks", async () => {
  persistence = new AppPersistence(":memory:"); setIbkrPortfolioPerformanceResourceStore(persistence.resources);
  for (const storedSource of [sourceKey, "old-query-fingerprint"]) {
    persistence.resources.set({ ...key, sourceKey: storedSource }, history, { schemaVersion: 1, cachePolicy: { staleMs: 60000, expireMs: 120000 } });
  }
  let requests = 0;
  setHttpFetchTransport(async () => { requests++; throw new Error("Controlled provider failure"); });
  expect(await getIbkrPortfolioPerformance(instance, "CONTROLLED")).toBeNull();
  expect(requests).toBe(1);
});

test("fresh NAV and cumulative percentage data persist under the corrected schema without mixing units", async () => {
  persistence = new AppPersistence(":memory:"); setIbkrPortfolioPerformanceResourceStore(persistence.resources);
  let requests = 0;
  setHttpFetchTransport(async (url) => {
    requests++;
    return new Response(url.includes("SendRequest")
      ? "<FlexStatementResponse><ReferenceCode>CONTROLLED</ReferenceCode></FlexStatementResponse>"
      : '<FlexStatements><FlexStatement accountId="CONTROLLED"><ChangeInNAV accountId="CONTROLLED" reportDate="20260901" currency="USD" endingValue="10000" cumulativeReturn="0"/><ChangeInNAV accountId="CONTROLLED" reportDate="20260902" currency="USD" endingValue="21000" cumulativeReturn="0.5" twr="10" mwr="20" deposits="10000"/></FlexStatement></FlexStatements>');
  });
  const result = await getIbkrPortfolioPerformance(instance, "CONTROLLED");
  expect(result?.points).toEqual([{ date: "2026-09-01", value: 10000, cumulativeReturn: 0 }, { date: "2026-09-02", value: 21000, cumulativeReturn: .005 }]);
  expect(persistence.resources.get<BrokerPortfolioPerformance>({ ...key, sourceKey }, { schemaVersion: 2 })?.value.points).toEqual(result?.points);
  expect((await getIbkrPortfolioPerformance(instance, "CONTROLLED"))?.points).toEqual(result?.points);
  expect(requests).toBe(2);
}, 10000);
