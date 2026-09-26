import { describe, expect, test } from "bun:test";
import {
  buildIbkrConfigFromValues,
  IBKR_CONFIG_FIELDS,
  IBKR_STATEMENT_URL,
  isCloudConfigured,
  isFlexConfigured,
  isGatewayConfigured,
  LEGACY_IBKR_STATEMENT_URL,
  normalizeIbkrConfig,
} from "./config";

describe("ibkr config helpers", () => {
  test("builds nested manual gateway config from flat wizard values", () => {
    const config = buildIbkrConfigFromValues({
      connectionMode: "gateway",
      gatewaySetupMode: "manual",
      host: "127.0.0.1",
      port: "4002",
    });

    expect(config.connectionMode).toBe("gateway");
    expect(config.gatewaySetupMode).toBe("manual");
    expect(config.gateway).toEqual({
      host: "127.0.0.1",
      port: 4002,
      clientId: undefined,
      lastSuccessfulPort: undefined,
      lastSuccessfulClientId: undefined,
      marketDataType: "auto",
    });
  });

  test("treats explicit port/client configs as manual at runtime", () => {
    const config = normalizeIbkrConfig({
      connectionMode: "gateway",
      host: "127.0.0.1",
      port: 4002,
      clientId: 1,
    });

    expect(config.gatewaySetupMode).toBe("manual");
    expect(config.gateway.port).toBe(4002);
    expect(config.gateway.clientId).toBe(1);
  });

  test("normalizes flat flex wizard values", () => {
    const config = normalizeIbkrConfig({
      token: "abc",
      queryId: "123",
    });

    expect(config.connectionMode).toBe("flex");
    expect(config.gatewaySetupMode).toBe("auto");
    expect(config.flex.token).toBe("abc");
    expect(config.flex.queryId).toBe("123");
    expect(config.flex.endpoint).toBe(IBKR_STATEMENT_URL);
  });

  test("migrates the legacy default Flex endpoint to the current IBKR endpoint", () => {
    const config = normalizeIbkrConfig({
      flex: {
        token: "abc",
        queryId: "123",
        endpoint: LEGACY_IBKR_STATEMENT_URL,
      },
    });

    expect(config.flex.endpoint).toBe(IBKR_STATEMENT_URL);
  });

  test("preserves custom non-default Flex endpoints", () => {
    const config = normalizeIbkrConfig({
      flex: {
        token: "abc",
        queryId: "123",
        endpoint: "https://example.com/custom/SendRequest",
      },
    });

    expect(config.flex.endpoint).toBe("https://example.com/custom/SendRequest");
  });

  test("round-trips IBKR sign-in profiles", () => {
    // The form sends every field's default, Gateway ones included.
    const config = buildIbkrConfigFromValues({
      connectionMode: "cloud",
      gatewaySetupMode: "auto",
      host: "127.0.0.1",
    });

    expect(config.connectionMode).toBe("cloud");
    const stored = config as unknown as Record<string, unknown>;
    expect(normalizeIbkrConfig(stored).connectionMode).toBe("cloud");
    expect(isCloudConfigured(stored)).toBe(true);
    expect(isFlexConfigured(stored)).toBe(false);
    expect(isGatewayConfigured(stored)).toBe(false);
  });

  test("keeps inferring stored profiles without a connection mode as before", () => {
    expect(normalizeIbkrConfig({ flex: { token: "abc", queryId: "123" } }).connectionMode).toBe("flex");
    expect(normalizeIbkrConfig({}).connectionMode).toBe("flex");
    expect(normalizeIbkrConfig({ gateway: { host: "127.0.0.1", port: 4002 } }).connectionMode).toBe("gateway");
    expect(normalizeIbkrConfig({ port: 4002 }).connectionMode).toBe("gateway");
    expect(isCloudConfigured({ flex: { token: "abc", queryId: "123" } })).toBe(false);
    expect(normalizeIbkrConfig({ connectionMode: "something-else" }).connectionMode).toBe("flex");
  });

  test("offers IBKR sign-in first and starts new profiles there", () => {
    const modeField = IBKR_CONFIG_FIELDS.find((field) => field.key === "connectionMode");

    expect(modeField?.defaultValue).toBe("cloud");
    expect(modeField?.options?.map((option) => option.value)).toEqual(["cloud", "flex", "gateway"]);
    expect(modeField?.options?.[0]?.label).toBe("IBKR sign-in");
  });
});
