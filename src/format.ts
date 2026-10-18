import type { PriceRange, ResourceFunction } from "./api";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** `5000` becomes `0.000005 SOL`. */
export function formatLamports(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  return `${sol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`;
}

export function formatPriceRange(price: PriceRange | null): string {
  if (!price) return "Free";
  if (price.minLamports === price.maxLamports) return formatLamports(price.minLamports);
  return `${formatLamports(price.minLamports)} – ${formatLamports(price.maxLamports)}`;
}

/** `temperature(city: string): decimal` */
export function signature(fn: ResourceFunction): string {
  return `${fn.name}(${fn.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}): ${fn.returnType}`;
}
