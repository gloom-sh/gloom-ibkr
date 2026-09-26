import { cloudError, connectionState, fakeCloud, type FakeCloudCall } from "./cloud/test-support";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BrokerPosition } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { BrokerAccount, BrokerOrderRequest, BrokerPortfolioPerformance } from "gloomberb/types/trading";
import { ibkrBroker } from "./broker-adapter";
import { setIbkrCloudSignInTiming } from "./cloud/connection";

/**
 * IBKR sign-in profiles reach IBKR only through the user's Gloom account. These
 * run the real adapter against a fake of that link and check the promises the
 * mode makes: a sync that finds IBKR signed out asks the user once and carries
 * on, orders become instructions the user reviews in IBKR, and nothing here
 * can change or cancel an order behind IBKR's review.
 */

const AUTHORIZE_URL = "https://www.interactivebrokers.com/authorize?state=abc";
const REVIEW_URL = "https://www.interactivebrokers.com/review/instruction-1";

let nextId = 0;

function cloudInstance(): BrokerInstanceConfig {
  nextId += 1;
  return {
    id: `ibkr-signin-${nextId}`,
    brokerType: "ibkr",
    label: "IBKR",
    connectionMode: "cloud",
    config: { connectionMode: "cloud" },
    enabled: true,
  };
}

const ACCOUNTS: BrokerAccount[] = [{
  accountId: "U1234567",
  name: "Interactive Brokers U1234567",
  currency: "USD",
  source: "cloud",
  updatedAt: 1_758_880_000_000,
  netLiquidation: 250000,
}];

const POSITIONS: BrokerPosition[] = [{
  ticker: "AAPL",
  exchange: "NASDAQ",
  shares: 10,
  currency: "USD",
  accountId: "U1234567",
  assetCategory: "STK",
  brokerContract: { brokerId: "ibkr", conId: 265598, symbol: "AAPL", secType: "STK" },
}];

function order(overrides: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest {
  return {
    brokerInstanceId: "ibkr-signin",
    accountId: "U1234567",
    contract: { brokerId: "ibkr", brokerInstanceId: "ibkr-signin", conId: 265598, symbol: "AAPL", secType: "STK" },
    action: "BUY",
    orderType: "LMT",
    quantity: 5,
    limitPrice: 180,
    tif: "DAY",
    ...overrides,
  };
}

function isStatusCheck(call: FakeCloudCall): boolean {
  return call.method === "GET" && call.path === "";
}

beforeEach(() => {
  fakeCloud.reset();
  setIbkrCloudSignInTiming({ pollIntervalMs: 5, timeoutMs: 1_000 });
});

afterEach(() => {
  fakeCloud.reset();
  setIbkrCloudSignInTiming(null);
});

describe("IBKR sign-in sync", () => {
  test("a sync that finds IBKR signed out signs in once and retries", async () => {
    const instance = cloudInstance();
    let snapshots = 0;
    let connected = false;
    fakeCloud.handler = (call) => {
      if (call.path === "/snapshot") {
        snapshots += 1;
        if (snapshots === 1) throw cloudError(404, "not_connected");
        return { accounts: ACCOUNTS, positions: POSITIONS, fetchedAt: 1 };
      }
      if (call.path === "/connect") {
        connected = true;
        return { authorizeUrl: AUTHORIZE_URL, expiresAt: "" };
      }
      if (isStatusCheck(call)) return connectionState({ connected, canWrite: connected });
      throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
    };

    const snapshot = await ibkrBroker.importPortfolioSnapshot!(instance);

    expect(snapshot).toEqual({ accounts: ACCOUNTS, positions: POSITIONS });
    expect(fakeCloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /snapshot",
      "GET ",
      "POST /connect",
      "GET ",
      "GET /snapshot",
    ]);
    expect(fakeCloud.openedUrls).toEqual([AUTHORIZE_URL]);
    expect(ibkrBroker.getStatus!(instance)).toMatchObject({ state: "connected", mode: "cloud" });
  });

  test("retries only once when the connection still is not there", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = (call) => {
      if (call.path === "/snapshot") throw cloudError(409, "reauth_required");
      if (isStatusCheck(call)) return connectionState({ connected: true, canWrite: true });
      throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
    };

    await expect(ibkrBroker.listAccounts!(instance)).rejects.toThrow("IBKR sign-in expired");
    expect(fakeCloud.calls.filter((call) => call.path === "/snapshot")).toHaveLength(2);
    expect(ibkrBroker.getStatus!(instance)).toMatchObject({
      state: "error",
      message: "IBKR sign-in expired. Connect again.",
    });
  });

  test("positions, accounts, history, orders and trades come from the shared connection", async () => {
    const instance = cloudInstance();
    const performance: BrokerPortfolioPerformance = {
      accountId: "U/1", source: "cloud", period: "1Y", measure: "TWR", flowBasis: "derived", fetchedAt: 1,
      points: [{ date: "2026-09-25", value: 250000, cumulativeReturn: 0.12, dailyReturn: 0.004, externalFlow: 0 }],
    };
    fakeCloud.handler = (call) => {
      switch (call.path) {
        case "/snapshot": return { accounts: ACCOUNTS, positions: POSITIONS, fetchedAt: 1 };
        case "/performance?accountId=U%2F1": return performance;
        case "/orders": return [{
          orderId: 7, status: "Submitted", action: "BUY", orderType: "LMT", quantity: 1, filled: 0, remaining: 1,
          updatedAt: 1, contract: { brokerId: "ibkr", symbol: "AAPL" },
        }];
        case "/executions?period=DAYS_90": return [];
        default: throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
      }
    };

    expect(await ibkrBroker.importPositions(instance)).toEqual(POSITIONS);
    expect(await ibkrBroker.listAccounts!(instance)).toEqual(ACCOUNTS);
    expect(await ibkrBroker.getPortfolioPerformance!(instance, "U/1")).toEqual(performance);
    const [openOrder] = await ibkrBroker.listOpenOrders!(instance);
    expect(openOrder?.brokerInstanceId).toBe(instance.id);
    expect(openOrder?.contract.brokerInstanceId).toBe(instance.id);
    expect(await ibkrBroker.listExecutions!(instance)).toEqual([]);
  });
});

describe("IBKR sign-in orders", () => {
  test("placing an order creates an instruction and opens it for review", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = (call) => {
      if (isStatusCheck(call)) return connectionState({ connected: true, canWrite: true });
      if (call.method === "POST" && call.path === "/instructions") return { id: "instruction-1", url: REVIEW_URL };
      throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
    };

    const placed = await ibkrBroker.placeOrder!(instance, order());

    expect(placed).toMatchObject({
      orderId: 0,
      status: "PendingReview",
      action: "BUY",
      orderType: "LMT",
      quantity: 5,
      filled: 0,
      remaining: 5,
      limitPrice: 180,
      tif: "DAY",
      reviewUrl: REVIEW_URL,
      warningText: "Review and submit this order in IBKR.",
      accountId: "U1234567",
    });
    expect(placed.contract.symbol).toBe("AAPL");
    expect(fakeCloud.openedUrls).toEqual([REVIEW_URL]);
    // Profile ids are local to this device and stay out of the request.
    expect(fakeCloud.calls.find((call) => call.path === "/instructions")?.body).toEqual({
      accountId: "U1234567",
      contract: { brokerId: "ibkr", conId: 265598, symbol: "AAPL", secType: "STK" },
      action: "BUY",
      orderType: "LMT",
      quantity: 5,
      limitPrice: 180,
      tif: "DAY",
    });
  });

  test("an order refused for lack of trading signs in for it and is sent again", async () => {
    const instance = cloudInstance();
    let canWrite = true;
    let instructions = 0;
    fakeCloud.handler = (call) => {
      if (isStatusCheck(call)) return connectionState({ connected: true, canWrite });
      if (call.path === "/connect") {
        canWrite = true;
        return { authorizeUrl: AUTHORIZE_URL, expiresAt: "" };
      }
      if (call.path === "/instructions") {
        instructions += 1;
        if (instructions === 1) {
          canWrite = false;
          throw cloudError(403, "write_not_granted");
        }
        return { id: "instruction-1", url: REVIEW_URL };
      }
      throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
    };

    const placed = await ibkrBroker.placeOrder!(instance, order({ orderType: "MKT", limitPrice: undefined }));

    expect(placed.reviewUrl).toBe(REVIEW_URL);
    expect(instructions).toBe(2);
    expect(fakeCloud.openedUrls).toEqual([AUTHORIZE_URL, REVIEW_URL]);
  });

  test("preview accepts market and limit orders and refuses stops without calling IBKR", async () => {
    const instance = cloudInstance();

    expect(await ibkrBroker.previewOrder!(instance, order())).toEqual({
      warningText: "IBKR will open this order for you to review and submit.",
    });
    await expect(ibkrBroker.previewOrder!(instance, order({ orderType: "STP", stopPrice: 170 })))
      .rejects.toThrow("IBKR sign-in sends market and limit orders only.");
    await expect(ibkrBroker.previewOrder!(instance, order({ orderType: "STP LMT", stopPrice: 170 })))
      .rejects.toThrow("IBKR sign-in sends market and limit orders only.");
    await expect(ibkrBroker.previewOrder!(instance, order({ limitPrice: 0 }))).rejects.toThrow("limit price");
    await expect(ibkrBroker.previewOrder!(instance, order({ quantity: 0 }))).rejects.toThrow("quantity");
    await expect(ibkrBroker.placeOrder!(instance, order({ orderType: "STP" })))
      .rejects.toThrow("IBKR sign-in sends market and limit orders only.");
    expect(fakeCloud.calls).toEqual([]);
  });

  test("orders sent for review cannot be changed or cancelled here", async () => {
    const instance = cloudInstance();

    await expect(ibkrBroker.modifyOrder!(instance, 0, order()))
      .rejects.toThrow("Orders sent through IBKR sign-in are managed in IBKR.");
    await expect(ibkrBroker.cancelOrder!(instance, 0))
      .rejects.toThrow("Orders sent through IBKR sign-in are managed in IBKR.");
    expect(fakeCloud.calls).toEqual([]);
  });
});

describe("IBKR sign-in profile", () => {
  test("round-trips through the profile form", () => {
    const instance = cloudInstance();
    const values = ibkrBroker.toConfigValues!(instance);
    expect(values.connectionMode).toBe("cloud");

    const config = ibkrBroker.fromConfigValues!(values, instance);
    expect(config.connectionMode).toBe("cloud");
    expect(ibkrBroker.toConfigValues!({ ...instance, config }).connectionMode).toBe("cloud");
  });

  test("validates on the Gloom session and never streams quotes", async () => {
    const instance = cloudInstance();

    expect(await ibkrBroker.validate(instance)).toBe(true);
    fakeCloud.signedIn = false;
    expect(await ibkrBroker.validate(instance)).toBe(false);
    // It reports "connected" but has no quote stream, so the host must not route quotes here.
    expect(ibkrBroker.canStreamQuotes!(instance)).toBe(false);
  });

  test("the console action points at the Trade tab", () => {
    const [action] = ibkrBroker.getProfileActions!(cloudInstance());

    expect(action?.disabled).toBe(true);
    expect(action?.disabledReason)
      .toBe("The IBKR Console needs a Gateway or TWS profile. Use the Trade tab to send orders to IBKR.");
  });

  test("status updates reach subscribers, and removing the profile leaves the grant alone", async () => {
    const instance = cloudInstance();
    fakeCloud.handler = (call) => {
      if (call.path === "/snapshot") return { accounts: [], positions: [], fetchedAt: 1 };
      throw new Error(`Unexpected IBKR request: ${call.method} ${call.path}`);
    };
    let updates = 0;
    const unsubscribe = ibkrBroker.subscribeStatus!(instance, () => { updates += 1; });

    expect(ibkrBroker.getStatus!(instance)).toMatchObject({ state: "disconnected", mode: "cloud" });
    await ibkrBroker.importPositions(instance);
    expect(ibkrBroker.getStatus!(instance)).toMatchObject({ state: "connected", message: "Signed in to IBKR" });
    expect(updates).toBe(1);

    await ibkrBroker.disconnect!(instance);
    unsubscribe();
    expect(fakeCloud.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(ibkrBroker.getStatus!(instance).state).toBe("disconnected");
  });
});
