import { maxTokens, parseScript } from "requestscript";

/**
 * The most script tokens any run of `source` can execute, which bounds what a node's per-token price
 * can charge for it. Null while the script doesn't parse.
 */
export function estimateMaxTokens(source: string): number | null {
  try {
    return maxTokens(parseScript(source));
  } catch {
    return null;
  }
}
