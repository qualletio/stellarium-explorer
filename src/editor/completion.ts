import { type Completion, type CompletionContext, type CompletionSource, snippet } from "@codemirror/autocomplete";
import type { ResourceFunction, ResourceSummary } from "../api";
import { formatFunctionPrice, formatResourcePrice, inferenceNote, signature } from "../format";
import { completionContext, findBindings, findVariables, KEYWORDS, TYPES } from "./analysis";
import type { ResourceProvider } from "./provider";

function infoNode(...lines: (string | null | undefined | false)[]): () => Node {
  return () => {
    const root = document.createElement("div");
    root.className = "cm-rs-info";
    for (const line of lines) {
      if (!line) continue;
      const p = document.createElement("p");
      p.textContent = line;
      root.append(p);
    }
    return root;
  };
}

function resourceOption(resource: ResourceSummary): Completion {
  const access = [
    formatResourcePrice(resource),
    resource.inferenceFunctionCount > 0 && `${resource.inferenceFunctionCount} inference`,
    resource.restrictedFunctionCount > 0 && `${resource.restrictedFunctionCount} restricted`,
  ].filter(Boolean);
  return {
    label: resource.fqn,
    type: "class",
    detail: `${resource.functionCount} fn · ${access.join(" · ")}`,
    info: infoNode(resource.description, `Hosted at ${resource.baseUrl}`),
  };
}

/** Inserts `fn(a: |, b: )` with a field per parameter, unless a `(` already follows. */
function functionOption(fn: ResourceFunction): Completion {
  const template = `${fn.name}(${fn.parameters.map((p) => `${p.name}: \${${p.name}}`).join(", ")})\${}`;
  const insert = snippet(template);
  return {
    label: fn.name,
    type: "function",
    detail: `(${fn.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) → ${fn.returnType}`,
    info: infoNode(
      signature(fn),
      fn.description,
      fn.paymentManifest ? `Costs ${formatFunctionPrice(fn)}` : "Free",
      inferenceNote(fn),
      fn.restricted && "Restricted: callers need a grant from the hosting node",
    ),
    apply: (view, completion, from, to) => {
      if (view.state.sliceDoc(to, to + 1) === "(") {
        view.dispatch({ changes: { from, to, insert: fn.name }, selection: { anchor: from + fn.name.length } });
      } else insert(view, completion, from, to);
    },
  };
}

export function requestScriptCompletion(provider: ResourceProvider): CompletionSource {
  return async (cx: CompletionContext) => {
    const source = cx.state.doc.toString();
    const context = completionContext(source, cx.pos);

    switch (context.kind) {
      case "none":
        return null;

      case "resourcePath": {
        const catalog = await provider.catalog();
        const options: Completion[] = (catalog?.items ?? []).map(resourceOption);
        if (!context.typed.includes(".")) {
          options.push(...TYPES.map((t) => ({ label: t, type: "type", boost: -1 })));
        }
        return { from: context.from, options, validFor: /^[\w.]*$/ };
      }

      case "member": {
        const detail = await provider.resource(context.binding.fqn);
        if (!detail) return null;
        return { from: context.from, options: detail.functions.map(functionOption), validFor: /^\w*$/ };
      }

      case "argument": {
        const detail = await provider.resource(context.binding.fqn);
        const fn = detail?.functions.find((f) => f.name === context.fn);
        if (!fn) return null;
        const options = fn.parameters
          .filter((p) => !context.used.includes(p.name))
          .map<Completion>((p) => ({
            label: p.name,
            type: "property",
            detail: p.type,
            info: p.description ? infoNode(p.description) : undefined,
            apply: `${p.name}: `,
            boost: 10,
          }));
        return { from: context.from, options, validFor: /^\w*$/ };
      }

      case "general": {
        if (!context.typed && !cx.explicit) return null;
        const bindings = new Set(findBindings(source).map((b) => b.name));
        const options: Completion[] = [
          ...KEYWORDS.map((k) => ({ label: k, type: "keyword" })),
          ...TYPES.map((t) => ({ label: t, type: "type" })),
          ...findVariables(source)
            .filter((v) => v !== context.typed)
            .map((v) => ({ label: v, type: bindings.has(v) ? "namespace" : "variable", boost: 5 })),
        ];
        return { from: context.from, options, validFor: /^\w*$/ };
      }
    }
  };
}
