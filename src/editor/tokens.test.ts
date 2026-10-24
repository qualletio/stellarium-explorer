import { describe, expect, it } from "vitest";
import { estimateMaxTokens } from "./tokens";

describe("estimateMaxTokens", () => {
  it("counts the costliest path through the script", () => {
    // return 1 + 2: four tokens. The costlier path skips the if's body: its 5 tokens and condition, then else's 3 and its body's 4.
    expect(estimateMaxTokens("request R {\n  return 1 + 2\n}")).toBe(4);
    expect(estimateMaxTokens("request R {\n  if (true) { return 1 } else { return 1 + 2 }\n}")).toBe(5 + 1 + 3 + 4);
  });

  it("is null while the script doesn't parse", () => {
    expect(estimateMaxTokens("request R {")).toBeNull();
    expect(estimateMaxTokens("")).toBeNull();
  });
});
