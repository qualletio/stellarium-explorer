/** Typed wrappers for the Rust commands in `src-tauri/src/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

export type NodeKind = "workspace" | "collection" | "folder" | "request";

export interface NetworkConfig {
  registryUrl?: string;
  nodeUrl?: string;
  /** The scope keeps a secret for its node in the OS keychain: its API key, or with `clientId` its API client's secret. */
  nodeKey?: boolean;
  /** The operator API that issues the API client's run tokens, including `/v1`. Set with `clientId`. */
  operatorUrl?: string;
  /** An API client for the node, used instead of an API key. */
  clientId?: string;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  name: string;
  description?: string;
  network?: NetworkConfig;
  children: TreeNode[];
}

export interface Tree {
  workspaces: TreeNode[];
  broken: { path: string; error: string }[];
}

export interface RequestDoc {
  id: string;
  name: string;
  description: string | null;
  source: string;
  network: NetworkConfig;
}

export interface ScopeRef {
  id: string;
  kind: NodeKind;
}

export interface ResolvedNetwork {
  registryUrl: string;
  /** Null when the registry is the built-in mainnet default. */
  registryFrom: ScopeRef | null;
  nodeUrl: string | null;
  nodeFrom: ScopeRef | null;
  nodeKeyScope: string | null;
  /** The API client the node's runs use, from the same scope as the node. */
  nodeClient: { operatorUrl: string; clientId: string } | null;
}

export interface NetworkSettings {
  own: NetworkConfig;
  inherited: ResolvedNetwork;
}

/** How saving network settings treats the scope's secret: its API key, or its API client's secret. */
export type KeyUpdate = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };

// Registry wire types, mirroring @registry/types. Prices are integer micro-USDC (1 USDC = 1,000,000).

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

export interface PriceRange {
  minMicroUsdc: number;
  maxMicroUsdc: number;
}

export interface ResourceSummary {
  fqn: string;
  path: string;
  name: string;
  baseUrl: string;
  description: string | null;
  functionCount: number;
  matchedFunctions: string[];
  /** Per-call prices of the fixed functions. Null when none is paid. */
  price: PriceRange | null;
  /** Paid functions of either kind. */
  paidFunctionCount: number;
  /** Paid inference functions, priced per token and so not in `price`. */
  perTokenFunctionCount: number;
  restrictedFunctionCount: number;
  inferenceFunctionCount: number;
  lastSeenAt: string;
  removedAt: string | null;
}

export interface FunctionParameter {
  name: string;
  type: string;
  description: string | null;
}

/** A fixed function's flat price per call. */
export interface FixedPaymentManifest {
  costMicroUsdc: number;
  recipientAddress: string;
}

/** An inference function's rates per million tokens. Either may be 0. */
export interface InferencePaymentManifest {
  inputCostMicroUsdcPerMillionTokens: number;
  outputCostMicroUsdcPerMillionTokens: number;
  recipientAddress: string;
}

/** Its shape follows the function's `kind`. */
export type PaymentManifest = FixedPaymentManifest | InferencePaymentManifest;

export const isInferenceManifest = (manifest: PaymentManifest): manifest is InferencePaymentManifest =>
  "inputCostMicroUsdcPerMillionTokens" in manifest;

/** Fixed functions have a flat price. Inference functions run AI inference, take `maxTokens` and are priced per token. */
export type FunctionKind = "fixed" | "inference";

export interface ResourceFunction {
  name: string;
  returnType: string;
  description: string | null;
  parameters: FunctionParameter[];
  paymentManifest: PaymentManifest | null;
  restricted: boolean;
  kind: FunctionKind;
}

export interface NodeInfo {
  baseUrl: string;
  name: string | null;
  publicKey: string | null;
  isSource: boolean;
  acceptsGrantRequests: boolean | null;
  grantEndpoint: string | null;
  grantProbedAt: string | null;
  lastSeenAt: string;
}

export interface ResourceDetail {
  fqn: string;
  path: string;
  name: string;
  baseUrl: string;
  website: string | null;
  description: string | null;
  functions: ResourceFunction[];
  host: NodeInfo | null;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
}

export interface Stats {
  resources: number;
  functions: number;
  paidFunctions: number;
  restrictedFunctions: number;
  inferenceFunctions: number;
  nodes: number;
  sourceUrl: string;
}

export type SearchField = "all" | "path" | "name" | "function";

export interface SearchQuery {
  q?: string;
  in?: SearchField;
  paid?: boolean;
  restricted?: boolean;
  inference?: boolean;
  offset?: number;
  limit?: number;
}

export interface Catalog {
  registryUrl: string;
  items: ResourceSummary[];
  fetchedAt: number;
  stale: boolean;
}

export interface RunResult {
  status: number | null;
  durationMs: number;
  returnValue: unknown;
  /** The script tokens the run executed, as the node reports them. */
  usageTokens: number | null;
  body: string;
  error: string | null;
}

export const api = {
  getTree: () => invoke<Tree>("get_tree"),
  createWorkspace: (name: string, description?: string, location?: string) =>
    invoke<string>("create_workspace", { name, description, location }),
  openWorkspace: (path: string) => invoke<string>("open_workspace", { path }),
  closeWorkspace: (id: string) => invoke<void>("close_workspace", { id }),
  forgetWorkspace: (path: string) => invoke<void>("forget_workspace", { path }),
  createCollection: (workspaceId: string, name: string, description?: string) =>
    invoke<string>("create_collection", { workspaceId, name, description }),
  createFolder: (parentId: string, name: string) => invoke<string>("create_folder", { parentId, name }),
  createRequest: (parentId: string, name: string) => invoke<string>("create_request", { parentId, name }),
  readRequest: (id: string) => invoke<RequestDoc>("read_request", { id }),
  saveRequest: (id: string, source: string) => invoke<void>("save_request", { id, source }),
  updateDetails: (id: string, name: string, description?: string) =>
    invoke<void>("update_details", { id, name, description }),
  moveNode: (id: string, parentId: string) => invoke<void>("move_node", { id, parentId }),
  deleteNode: (id: string) => invoke<void>("delete_node", { id }),
  getNetwork: (id: string) => invoke<NetworkSettings>("get_network", { id }),
  setNetwork: (id: string, network: NetworkConfig, apiKey: KeyUpdate) =>
    invoke<void>("set_network", { id, network, apiKey }),
  resolveNetwork: (id: string) => invoke<ResolvedNetwork>("resolve_network", { id }),
  searchResources: (registryUrl: string, query: SearchQuery) =>
    invoke<Page<ResourceSummary>>("search_resources", { registryUrl, query }),
  getResource: (registryUrl: string, fqn: string) => invoke<ResourceDetail>("get_resource", { registryUrl, fqn }),
  registryStats: (registryUrl: string) => invoke<Stats>("registry_stats", { registryUrl }),
  getCatalog: (registryUrl: string, refresh = false) => invoke<Catalog>("get_catalog", { registryUrl, refresh }),
  runRequest: (id: string, source: string, runId: string) => invoke<RunResult>("run_request", { id, source, runId }),
  cancelRun: (runId: string) => invoke<void>("cancel_run", { runId }),
};

/** Tauri rejects with the command's error message as a string. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
