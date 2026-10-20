import { describe, expect, it } from "vitest";
import type { ResourceFunction, ResourceSummary } from "./api";
import { formatFunctionPrice, formatResourcePrice } from "./format";

const fn = (paymentManifest: ResourceFunction["paymentManifest"], kind: ResourceFunction["kind"] = "fixed"): ResourceFunction => ({
  name: "f",
  returnType: "string",
  description: null,
  parameters: [],
  paymentManifest,
  restricted: false,
  kind,
});

const resource = (price: ResourceSummary["price"], perTokenFunctionCount: number): ResourceSummary => ({
  fqn: "a.B",
  path: "a",
  name: "B",
  baseUrl: "http://node",
  description: null,
  functionCount: 2,
  matchedFunctions: [],
  price,
  paidFunctionCount: (price ? 1 : 0) + perTokenFunctionCount,
  perTokenFunctionCount,
  restrictedFunctionCount: 0,
  inferenceFunctionCount: perTokenFunctionCount,
  lastSeenAt: "",
  removedAt: null,
});

describe("prices", () => {
  it("formats a function's flat or per-token price", () => {
    expect(formatFunctionPrice(fn(null))).toBe("Free");
    expect(formatFunctionPrice(fn({ costMicroUsdc: 10_000, recipientAddress: "r" }))).toBe("0.01 USDC per call");
    const manifest = { inputCostMicroUsdcPerMillionTokens: 3_000_000, outputCostMicroUsdcPerMillionTokens: 15_000_000, recipientAddress: "r" };
    expect(formatFunctionPrice(fn(manifest, "inference"))).toBe("3.00 USDC in / 15.00 USDC out per 1M tokens");
  });

  it("doesn't call a resource with only per-token functions free", () => {
    expect(formatResourcePrice(resource(null, 0))).toBe("Free");
    expect(formatResourcePrice(resource(null, 1))).toBe("per token");
    expect(formatResourcePrice(resource({ minMicroUsdc: 10_000, maxMicroUsdc: 10_000 }, 1))).toBe("0.01 USDC / per token");
  });
});
