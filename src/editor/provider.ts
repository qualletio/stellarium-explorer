import type { Catalog, ResourceDetail } from "../api";

/** Where the editor gets resources from: the registry the request resolves to. */
export interface ResourceProvider {
  catalog(): Promise<Catalog | null>;
  /** The catalog if it is already loaded, for synchronous checks. */
  cachedCatalog(): Catalog | null;
  resource(fqn: string): Promise<ResourceDetail | null>;
}
