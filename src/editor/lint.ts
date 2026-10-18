import { type Diagnostic, linter } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { parseScript, RequestScriptError } from "requestscript";
import { findBindings } from "./analysis";
import type { ResourceProvider } from "./provider";

/** Converts RequestScript's 1-based line and column to a document offset. */
function offset(doc: Text, line: number | undefined, column: number | undefined): number {
  if (!line) return doc.length;
  const docLine = doc.line(Math.min(Math.max(line, 1), doc.lines));
  return Math.min(docLine.from + Math.max((column ?? 1) - 1, 0), docLine.to);
}

/** Syntax errors from the reference parser, and resources the registry doesn't list. */
export function diagnose(doc: Text, provider: ResourceProvider): Diagnostic[] {
  const source = doc.toString();
  const diagnostics: Diagnostic[] = [];
  try {
    parseScript(source);
  } catch (error) {
    if (error instanceof RequestScriptError) {
      const from = offset(doc, error.line, error.column);
      const word = /^\w+/.exec(source.slice(from))?.[0].length ?? 1;
      diagnostics.push({
        from,
        to: Math.min(from + word, doc.length),
        severity: "error",
        message: error.message.replace(/\s*\(line \d+\)$/, ""),
      });
    }
  }

  const catalog = provider.cachedCatalog();
  if (catalog && !catalog.stale) {
    const known = new Set(catalog.items.map((r) => r.fqn));
    for (const binding of findBindings(source)) {
      if (!known.has(binding.fqn)) {
        diagnostics.push({
          from: binding.from,
          to: binding.to,
          severity: "warning",
          message: `${binding.fqn} isn't listed on this registry`,
        });
      }
    }
  }
  return diagnostics;
}

export function requestScriptLinter(provider: ResourceProvider) {
  return linter((view) => diagnose(view.state.doc, provider), { delay: 350 });
}
