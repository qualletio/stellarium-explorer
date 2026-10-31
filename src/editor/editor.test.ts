import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { ensureSyntaxTree, getIndentation, indentUnit } from "@codemirror/language";
import { EditorState, Text } from "@codemirror/state";
import { classHighlighter, highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import type { Catalog, ResourceDetail, ResourceSummary } from "../api";
import { requestScriptCompletion } from "./completion";
import { requestScriptLanguage } from "./language";
import { diagnose } from "./lint";
import type { ResourceProvider } from "./provider";

const summary = (fqn: string): ResourceSummary => ({
  fqn,
  path: fqn.slice(0, fqn.lastIndexOf(".")),
  name: fqn.slice(fqn.lastIndexOf(".") + 1),
  baseUrl: "http://node",
  description: null,
  functionCount: 1,
  matchedFunctions: [],
  price: null,
  paidFunctionCount: 0,
  perTokenFunctionCount: 0,
  restrictedFunctionCount: 0,
  inferenceFunctionCount: 0,
  isContract: false,
  lastSeenAt: "",
  removedAt: null,
});

const weather: ResourceDetail = {
  ...summary("com.example.Weather"),
  website: null,
  functions: [
    {
      name: "temperature",
      returnType: "decimal",
      description: "Current temperature",
      parameters: [
        { name: "city", type: "string", description: null },
        { name: "units", type: "string", description: null },
      ],
      paymentManifest: { costMicroUsd: 5000, recipientOrganizationId: "r" },
      restricted: false,
      kind: "fixed",
    },
  ],
  contract: null,
  host: null,
  firstSeenAt: "",
};

const visitsSummary: ResourceSummary = { ...summary("org.archive.Visits"), isContract: true, paidFunctionCount: 1, perTokenFunctionCount: 1 };

const visits: ResourceDetail = {
  ...summary("org.archive.Visits"),
  website: null,
  functions: [
    {
      name: "run",
      returnType: "int32",
      description: null,
      parameters: [{ name: "bookId", type: "string", description: null }],
      paymentManifest: { priceMicroUsdPerMillionTokens: 2_000_000, recipientOrganizationId: "r" },
      restricted: false,
      kind: "contract",
    },
  ],
  contract: {
    ownerOrganizationId: null,
    latestVersion: "1.1",
    versions: [],
    source: "contract org.archive.Visits(bookId: string): int32 { return 1 }",
    syncedAt: null,
  },
  host: null,
  firstSeenAt: "",
};

const catalog: Catalog = {
  registryUrl: "http://registry/v1",
  items: [summary("com.example.Weather"), summary("org.archive.Books"), visitsSummary],
  fetchedAt: 0,
  stale: false,
};

const provider: ResourceProvider = {
  catalog: async () => catalog,
  cachedCatalog: () => catalog,
  resource: async (fqn) => [weather, visits].find((r) => r.fqn === fqn) ?? null,
};

function state(marked: string) {
  const pos = marked.indexOf("|");
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  return { state: EditorState.create({ doc, extensions: [requestScriptLanguage(), indentUnit.of("    ")] }), pos };
}

async function complete(marked: string, explicit = false) {
  const { state: s, pos } = state(marked);
  return (await requestScriptCompletion(provider)(new CompletionContext(s, pos, explicit))) as CompletionResult | null;
}

const labels = (result: CompletionResult | null) => result?.options.map((o) => o.label) ?? [];

const HEADER = "request R {\n    const weather: com.example.Weather\n";

describe("completion", () => {
  it("offers registry resources in a declaration", async () => {
    const result = await complete("request R {\n    const b: org.|");
    expect(labels(result)).toEqual(["com.example.Weather", "org.archive.Books", "org.archive.Visits"]);
    expect(result?.from).toBe("request R {\n    const b: ".length);
  });

  it("marks contracts among the resources", async () => {
    const result = await complete("request R {\n    const v: org.archive.V|");
    const option = result?.options.find((o) => o.label === "org.archive.Visits");
    expect(option).toMatchObject({ type: "contract", detail: "contract · per token" });
    expect(result?.options.find((o) => o.label === "org.archive.Books")?.type).toBe("class");
  });

  it("offers a contract's run function", async () => {
    const result = await complete("request R {\n    const visits: org.archive.Visits\n    visits.|");
    expect(labels(result)).toEqual(["run"]);
    expect(result?.options[0].detail).toBe("(bookId: string) → int32");
    expect(labels(await complete("request R {\n    const visits: org.archive.Visits\n    visits.run(|)"))).toEqual(["bookId"]);
  });

  it("offers a bound resource's functions", async () => {
    const result = await complete(`${HEADER}    weather.|`);
    expect(labels(result)).toEqual(["temperature"]);
    expect(result?.options[0].detail).toBe("(city: string, units: string) → decimal");
  });

  it("offers the arguments not yet given", async () => {
    expect(labels(await complete(`${HEADER}    weather.temperature(city: "Oslo", |)`))).toEqual(["units"]);
  });

  it("offers keywords and variables only when asked or typing", async () => {
    expect(await complete(`${HEADER}    |`)).toBeNull();
    expect(labels(await complete(`${HEADER}    we|`))).toContain("weather");
    expect(labels(await complete(`${HEADER}    |`, true))).toContain("return");
  });
});

describe("highlighting", () => {
  it("tokenizes declarations, strings and interpolations", () => {
    const { state: s } = state('request R {\n    const w: com.example.Weather\n    return "a ${w.f(x: 1)} b" // done\n}|');
    const tree = ensureSyntaxTree(s, s.doc.length, 5000)!;
    const tokens: [string, string][] = [];
    const functions = tagHighlighter([{ tag: tags.function(tags.propertyName), class: "tok-function" }]);
    highlightTree(tree, [functions, classHighlighter], (from, to, classes) => tokens.push([s.sliceDoc(from, to), classes]));
    const classOf = (text: string) => tokens.find(([t]) => t === text)?.[1];
    expect(classOf("request")).toBe("tok-keyword");
    expect(classOf("w")).toBe("tok-variableName tok-definition");
    expect(classOf("com.example.Weather")).toBe("tok-typeName");
    expect(classOf('"a ')).toBe("tok-string");
    expect(classOf("f")).toBe("tok-function tok-propertyName");
    expect(classOf("x")).toBe("tok-propertyName");
    expect(classOf("1")).toBe("tok-number");
    expect(classOf(' b"')).toBe("tok-string");
    expect(classOf("// done")).toBe("tok-comment");
  });

  it("highlights a contract's state declarations", () => {
    const { state: s } = state("contract a.B(id: string): int32 {\n    var state(id) views: int32 = 0\n}|");
    const tree = ensureSyntaxTree(s, s.doc.length, 5000)!;
    const tokens: [string, string][] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => tokens.push([s.sliceDoc(from, to), classes]));
    expect(tokens.find(([t]) => t === "state")?.[1]).toBe("tok-keyword");
  });

  it("indents by brace depth", () => {
    const { state: s } = state("request R {\n    if (x) {\n\n    }\n}|");
    expect(getIndentation(s, s.doc.line(3).from)).toBe(8);
    expect(getIndentation(s, s.doc.line(4).from)).toBe(4);
  });
});

describe("lint", () => {
  it("reports parse errors at their position", () => {
    const doc = Text.of(["request R {", "    return 1 +", "}"]);
    expect(diagnose(doc, provider)).toEqual([{ from: doc.line(3).from, to: doc.line(3).from + 1, severity: "error", message: "Unexpected '}'" }]);
  });

  it("warns about resources the registry doesn't list", () => {
    const doc = Text.of(["request R {", "    const x: com.example.Missing", "    return null", "}"]);
    const [warning] = diagnose(doc, provider);
    expect(warning).toMatchObject({ severity: "warning", message: "com.example.Missing isn't listed on this registry" });
    expect(doc.sliceString(warning.from, warning.to)).toBe("com.example.Missing");
  });
});
