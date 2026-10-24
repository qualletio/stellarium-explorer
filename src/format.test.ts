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
    expect(formatFunctionPrice(fn({ costMicroUsd: 10_000, recipientOrganizationId: "r" }))).toBe("$0.01 per call");
    const manifest = { inputCostMicroUsdPerMillionTokens: 3_000_000, outputCostMicroUsdPerMillionTokens: 15_000_000, recipientOrganizationId: "r" };
    expect(formatFunctionPrice(fn(manifest, "inference"))).toBe("$3.00 in / $15.00 out per 1M tokens");
  });

  it("doesn't call a resource with only per-token functions free", () => {
    expect(formatResourcePrice(resource(null, 0))).toBe("Free");
    expect(formatResourcePrice(resource(null, 1))).toBe("per token");
    expect(formatResourcePrice(resource({ minMicroUsd: 10_000, maxMicroUsd: 10_000 }, 1))).toBe("$0.01 / per token");
  });
});
