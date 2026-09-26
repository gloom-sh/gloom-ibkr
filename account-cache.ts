import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { CachePolicy } from "gloomberb/types/persistence";
import { normalizeIbkrConfig } from "./config";
import { fnv1aHashString } from "gloomberb/utils";

const FLEX_ACCOUNT_CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

const GATEWAY_ACCOUNT_CACHE_POLICY = {
  staleMs: 30 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const satisfies CachePolicy;

export function getIbkrAccountCacheSourceKey(instance: BrokerInstanceConfig): string {
  const config = normalizeIbkrConfig(instance.config);
  // Sign-in accounts come from the shared connection, not from the profile, so
  // leftover Flex or Gateway fields on a sign-in profile must not discard them.
  if (config.connectionMode === "cloud") return fnv1aHashString(JSON.stringify({ connectionMode: "cloud" }));
  return fnv1aHashString(JSON.stringify(config));
}

export function getIbkrAccountCachePolicy(instance: BrokerInstanceConfig): CachePolicy {
  return normalizeIbkrConfig(instance.config).connectionMode === "gateway"
    ? GATEWAY_ACCOUNT_CACHE_POLICY
    : FLEX_ACCOUNT_CACHE_POLICY;
}
