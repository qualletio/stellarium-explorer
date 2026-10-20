import { hoverTooltip } from "@codemirror/view";
import { formatUsdc, signature } from "../format";
import { symbolAt } from "./analysis";
import type { ResourceProvider } from "./provider";

function tooltipDom(title: string, ...lines: (string | null | undefined | false)[]) {
  const dom = document.createElement("div");
  dom.className = "cm-rs-hover";
  const heading = document.createElement("code");
  heading.textContent = title;
  dom.append(heading);
  for (const line of lines) {
    if (!line) continue;
    const p = document.createElement("p");
    p.textContent = line;
    dom.append(p);
  }
  return { dom };
}

/** Describes resources, functions and arguments from the registry on hover. */
export function requestScriptHover(provider: ResourceProvider) {
  return hoverTooltip(async (view, pos) => {
    const symbol = symbolAt(view.state.doc.toString(), pos);
    if (!symbol) return null;
    const detail = await provider.resource(symbol.binding.fqn);
    if (!detail) return null;

    const base = { pos: symbol.from, end: symbol.to, above: true };
    if (symbol.kind === "binding") {
      return { ...base, create: () => tooltipDom(detail.fqn, detail.description, `Hosted at ${detail.baseUrl}`, detail.website) };
    }
    const fn = detail.functions.find((f) => f.name === symbol.fn);
    if (!fn) return null;
    if (symbol.kind === "function") {
      return {
        ...base,
        create: () =>
          tooltipDom(
            signature(fn),
            fn.description,
            fn.paymentManifest ? `Costs ${formatUsdc(fn.paymentManifest.costMicroUsdc)} per call` : "Free",
            fn.restricted && "Restricted: callers need a grant from the hosting node",
          ),
      };
    }
    const parameter = fn.parameters.find((p) => p.name === symbol.name);
    if (!parameter) return null;
    return { ...base, create: () => tooltipDom(`${parameter.name}: ${parameter.type}`, parameter.description) };
  });
}
