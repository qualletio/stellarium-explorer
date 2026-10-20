import { isInferenceManifest, type ResourceFunction, type ResourceSummary } from "./api";

const MICRO_USDC_PER_USDC = 1_000_000;

/** `10000` becomes `0.01 USDC`. */
export function formatUsdc(microUsdc: number): string {
  const usdc = microUsdc / MICRO_USDC_PER_USDC;
  return `${usdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

/** The per-call range of a resource's fixed functions, plus "per token" if it has paid inference functions. */
export function formatResourcePrice(resource: ResourceSummary): string {
  const parts: string[] = [];
  const { price } = resource;
  if (price) {
    parts.push(price.minMicroUsdc === price.maxMicroUsdc ? formatUsdc(price.minMicroUsdc) : `${formatUsdc(price.minMicroUsdc)} – ${formatUsdc(price.maxMicroUsdc)}`);
  }
  if (resource.perTokenFunctionCount > 0) parts.push("per token");
  return parts.length ? parts.join(" / ") : "Free";
}

/** `0.01 USDC per call`, or `3.00 USDC in / 15.00 USDC out per 1M tokens` for an inference function. */
export function formatFunctionPrice(fn: ResourceFunction): string {
  const manifest = fn.paymentManifest;
  if (!manifest) return "Free";
  if (isInferenceManifest(manifest)) {
    return `${formatUsdc(manifest.inputCostMicroUsdcPerMillionTokens)} in / ${formatUsdc(manifest.outputCostMicroUsdcPerMillionTokens)} out per 1M tokens`;
  }
  return `${formatUsdc(manifest.costMicroUsdc)} per call`;
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
