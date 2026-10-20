import type { PriceRange, ResourceFunction } from "./api";

const MICRO_USDC_PER_USDC = 1_000_000;

/** `10000` becomes `0.01 USDC`. */
export function formatUsdc(microUsdc: number): string {
  const usdc = microUsdc / MICRO_USDC_PER_USDC;
  return `${usdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

export function formatPriceRange(price: PriceRange | null): string {
  if (!price) return "Free";
  if (price.minMicroUsdc === price.maxMicroUsdc) return formatUsdc(price.minMicroUsdc);
  return `${formatUsdc(price.minMicroUsdc)} – ${formatUsdc(price.maxMicroUsdc)}`;
}

/** `temperature(city: string): decimal` */
export function signature(fn: ResourceFunction): string {
  return `${fn.name}(${fn.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}): ${fn.returnType}`;
}
