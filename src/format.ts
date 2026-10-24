import { isInferenceManifest, type ResourceFunction, type ResourceSummary } from "./api";

const MICRO_USD_PER_USD = 1_000_000;

/** `10000` becomes `$0.01`. */
export function formatUsd(microUsd: number): string {
  const usd = microUsd / MICRO_USD_PER_USD;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** The per-call range of a resource's fixed functions, plus "per token" if it has paid inference functions. */
export function formatResourcePrice(resource: ResourceSummary): string {
  const parts: string[] = [];
  const { price } = resource;
  if (price) {
    parts.push(price.minMicroUsd === price.maxMicroUsd ? formatUsd(price.minMicroUsd) : `${formatUsd(price.minMicroUsd)} – ${formatUsd(price.maxMicroUsd)}`);
  }
  if (resource.perTokenFunctionCount > 0) parts.push("per token");
  return parts.length ? parts.join(" / ") : "Free";
}

/** `$0.01 per call`, or `$3.00 in / $15.00 out per 1M tokens` for an inference function. */
export function formatFunctionPrice(fn: ResourceFunction): string {
  const manifest = fn.paymentManifest;
  if (!manifest) return "Free";
  if (isInferenceManifest(manifest)) {
    return `${formatUsd(manifest.inputCostMicroUsdPerMillionTokens)} in / ${formatUsd(manifest.outputCostMicroUsdPerMillionTokens)} out per 1M tokens`;
  }
  return `${formatUsd(manifest.costMicroUsd)} per call`;
}

/** Extra lines for hovers and completions: what `kind: "inference"` means for the caller. */
export function inferenceNote(fn: ResourceFunction): string | false {
  if (fn.kind !== "inference") return false;
  return fn.paymentManifest
    ? "Inference: maxTokens caps the output tokens. Your node signs for the estimated maximum and pays only for the tokens used."
    : "Inference: maxTokens caps the output tokens";
}

/** `temperature(city: string): decimal` */
export function signature(fn: ResourceFunction): string {
  return `${fn.name}(${fn.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}): ${fn.returnType}`;
}
