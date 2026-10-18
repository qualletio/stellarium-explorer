import { describe, expect, it } from "vitest";
import { completionContext, findBindings, findVariables, symbolAt } from "./analysis";

/** Splits `source` at the `|` marker. */
function at(marked: string): [string, number] {
  const pos = marked.indexOf("|");
  return [marked.slice(0, pos) + marked.slice(pos + 1), pos];
}

const WEATHER = `request R {
    const weather: com.example.Weather
    // const fake: not.Real
    const label = "const nope: a.B"
`;

describe("findBindings", () => {
  it("finds resource bindings outside comments and strings", () => {
    const bindings = findBindings(WEATHER);
    expect(bindings).toMatchObject([{ name: "weather", fqn: "com.example.Weather" }]);
    expect(WEATHER.slice(bindings[0].from, bindings[0].to)).toBe("com.example.Weather");
    expect(findVariables(WEATHER)).toEqual(["weather", "label"]);
  });
});

describe("completionContext", () => {
  it("completes resource paths in a declaration", () => {
    expect(completionContext(...at("request R {\n  const w: |"))).toEqual({ kind: "resourcePath", from: 23, typed: "" });
    expect(completionContext(...at("request R {\n  const w: com.exa|"))).toMatchObject({ kind: "resourcePath", typed: "com.exa" });
  });

  it("completes functions on a bound resource", () => {
    const [source, pos] = at(`${WEATHER}    weather.te|`);
    expect(completionContext(source, pos)).toMatchObject({ kind: "member", typed: "te", binding: { fqn: "com.example.Weather" } });
    expect(completionContext(...at(`${WEATHER}    label.|`))).toEqual({ kind: "none" });
  });

  it("completes named arguments that are still missing", () => {
    expect(completionContext(...at(`${WEATHER}    weather.temperature(|`))).toMatchObject({ kind: "argument", fn: "temperature", typed: "", used: [] });
    expect(completionContext(...at(`${WEATHER}    weather.temperature(city: "Oslo", opts: { a: 1, b: 2 }, un|`))).toMatchObject({
      kind: "argument",
      typed: "un",
      used: ["city", "opts"],
    });
    // Typing a value, not a name.
    expect(completionContext(...at(`${WEATHER}    weather.temperature(city: ci|`)).kind).toBe("general");
  });

  it("stays quiet in strings and comments", () => {
    expect(completionContext(...at(`${WEATHER}    return "weather.|`))).toEqual({ kind: "none" });
    expect(completionContext(...at(`${WEATHER}    // weather.|`))).toEqual({ kind: "none" });
    // Interpolations are code.
    expect(completionContext(...at(`${WEATHER}    return "\${weather.|`)).kind).toBe("member");
  });

  it("falls back to general completion", () => {
    expect(completionContext(...at(`${WEATHER}    ret|`))).toMatchObject({ kind: "general", typed: "ret" });
  });
});

describe("symbolAt", () => {
  const source = `${WEATHER}    const t = weather.temperature(city: "Oslo")\n}`;
  it("resolves bindings, functions and arguments", () => {
    expect(symbolAt(source, source.indexOf("weather.temp") + 2)).toMatchObject({ kind: "binding" });
    expect(symbolAt(source, source.indexOf("temperature") + 3)).toMatchObject({ kind: "function", fn: "temperature" });
    expect(symbolAt(source, source.indexOf("city") + 1)).toMatchObject({ kind: "argument", fn: "temperature", name: "city" });
    expect(symbolAt(source, source.indexOf("label"))).toBeNull();
  });
});
