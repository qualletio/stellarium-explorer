import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import {
  api,
  type Catalog,
  errorMessage,
  type ResolvedNetwork,
  type ResourceDetail,
  type RunResult,
  type Tree,
  type TreeNode,
} from "./api";
import { checkForUpdate, installAndRelaunch } from "./updater";

export interface Tab {
  id: string;
  name: string;
  /** The editor's current text. */
  source: string;
  /** The text last read from or written to disk. */
  saved: string;
  /** Bumped when `source` is replaced from outside the editor (a file changed on disk). */
  revision: number;
  network: ResolvedNetwork | null;
  result: RunResult | null;
  /** The id of the run in flight. */
  runId: string | null;
}

export interface CatalogState {
  catalog: Catalog | null;
  error: string | null;
  loading: boolean;
}

export type Dialog =
  | { kind: "details"; mode: "create"; nodeKind: TreeNode["kind"]; parentId?: string }
  | { kind: "details"; mode: "edit"; node: TreeNode }
  | { kind: "network"; node: TreeNode }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; onConfirm: () => Promise<void> | void };

export interface UpdateState {
  version: string;
  status: "available" | "installing" | "error";
  /** Download progress, 0–1; null while unknown. */
  progress: number | null;
  error: string | null;
}

interface State {
  tree: Tree;
  activeWorkspaceId: string | null;
  expanded: Record<string, boolean>;
  tabs: Tab[];
  activeTabId: string | null;
  catalogs: Record<string, CatalogState>;
  /** Bumped by `refreshResources`, so views showing registry data refetch it. */
  resourcesRevision: number;
  dialog: Dialog | null;
  /** The sidebar node whose name is being edited in place. */
  renamingId: string | null;
  toast: { message: string; error: boolean } | null;
  browserOpen: boolean;
  update: UpdateState | null;

  loadTree(): Promise<void>;
  setActiveWorkspace(id: string | null): void;
  toggleExpanded(id: string, open?: boolean): void;
  openRequest(id: string): Promise<void>;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  editSource(id: string, source: string): void;
  saveTab(id: string): Promise<void>;
  run(id: string): Promise<void>;
  cancelRun(id: string): void;
  refreshNetworks(): Promise<void>;
  loadCatalog(registryUrl: string, refresh?: boolean): Promise<Catalog | null>;
  /** Refetches a registry's catalog and resource details, for the browser and the editor. */
  refreshResources(registryUrl: string): Promise<void>;
  setDialog(dialog: Dialog | null): void;
  setRenaming(id: string | null): void;
  notify(message: string, error?: boolean): void;
  toggleBrowser(): void;
  /** `manual` checks report "up to date" and show versions the user said "later" to. */
  checkForUpdates(manual?: boolean): Promise<void>;
  installUpdate(): void;
  dismissUpdate(): void;
}

const WORKSPACE_KEY = "explorer.activeWorkspace";
const DISMISSED_UPDATE_KEY = "explorer.dismissedUpdate";

function dismissedUpdate(): string | null {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_KEY);
  } catch {
    return null;
  }
}

/** The plugin's handle for the available update; it holds a native resource, so it stays out of state. */
let pendingUpdate: Update | null = null;

function storedWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** The ids from a workspace down to `id`, inclusive. */
export function pathTo(nodes: TreeNode[], id: string): string[] {
  for (const node of nodes) {
    if (node.id === id) return [id];
    const rest = pathTo(node.children, id);
    if (rest.length) return [node.id, ...rest];
  }
  return [];
}

export const isDirty = (tab: Tab) => tab.source !== tab.saved;

const catalogRequests = new Map<string, Promise<Catalog | null>>();
const detailRequests = new Map<string, Promise<ResourceDetail | null>>();

/** A resource's detail from a registry, shared by the editor and browser. Failures aren't cached. */
export function resourceDetail(registryUrl: string, fqn: string): Promise<ResourceDetail | null> {
  const key = `${registryUrl} ${fqn}`;
  let request = detailRequests.get(key);
  if (!request) {
    request = api.getResource(registryUrl, fqn).catch(() => {
      detailRequests.delete(key);
      return null;
    });
    detailRequests.set(key, request);
    // The backend keeps its own cache with a TTL; let ours lapse too.
    setTimeout(() => detailRequests.delete(key), 10 * 60 * 1000);
  }
  return request;
}

export const useStore = create<State>((set, get) => ({
  tree: { workspaces: [], broken: [] },
  activeWorkspaceId: storedWorkspace(),
  expanded: {},
  tabs: [],
  activeTabId: null,
  catalogs: {},
  resourcesRevision: 0,
  dialog: null,
  renamingId: null,
  toast: null,
  browserOpen: true,
  update: null,

  async loadTree() {
    let tree: Tree;
    try {
      tree = await api.getTree();
    } catch (error) {
      get().notify(errorMessage(error), true);
      return;
    }
    const { activeWorkspaceId, tabs } = get();
    const workspaceExists = tree.workspaces.some((w) => w.id === activeWorkspaceId);
    // Tabs whose requests are gone (deleted, or their workspace closed) close, unless they hold unsaved work.
    const keep = tabs.filter((t) => findNode(tree.workspaces, t.id) || isDirty(t));
    set({
      tree,
      activeWorkspaceId: workspaceExists ? activeWorkspaceId : (tree.workspaces[0]?.id ?? null),
      tabs: keep.map((t) => ({ ...t, name: findNode(tree.workspaces, t.id)?.name ?? t.name })),
      activeTabId: keep.some((t) => t.id === get().activeTabId) ? get().activeTabId : (keep[0]?.id ?? null),
    });
    if (!workspaceExists) get().setActiveWorkspace(get().activeWorkspaceId);

    // Pick up edits made on disk to requests that have no unsaved changes here.
    await Promise.all(
      keep
        .filter((t) => !isDirty(t) && findNode(tree.workspaces, t.id))
        .map(async (t) => {
          const doc = await api.readRequest(t.id).catch(() => null);
          if (doc && doc.source !== t.saved) {
            set({ tabs: get().tabs.map((x) => (x.id === t.id && !isDirty(x) ? { ...x, source: doc.source, saved: doc.source, revision: x.revision + 1 } : x)) });
          }
        }),
    );
    await get().refreshNetworks();
  },

  setActiveWorkspace(id) {
    set({ activeWorkspaceId: id });
    try {
      if (id) localStorage.setItem(WORKSPACE_KEY, id);
      else localStorage.removeItem(WORKSPACE_KEY);
    } catch {
      // Remembering the workspace is a convenience only.
    }
  },

  toggleExpanded(id, open) {
    set({ expanded: { ...get().expanded, [id]: open ?? !get().expanded[id] } });
  },

  async openRequest(id) {
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
      return;
    }
    try {
      const [doc, network] = await Promise.all([api.readRequest(id), api.resolveNetwork(id)]);
      const tab: Tab = { id, name: doc.name, source: doc.source, saved: doc.source, revision: 0, network, result: null, runId: null };
      set({ tabs: [...get().tabs.filter((t) => t.id !== id), tab], activeTabId: id });
      void get().loadCatalog(network.registryUrl);
    } catch (error) {
      get().notify(errorMessage(error), true);
    }
  },

  closeTab(id) {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    const next = activeTabId === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : activeTabId;
    set({ tabs: rest, activeTabId: next });
  },

  setActiveTab(id) {
    set({ activeTabId: id });
  },

  editSource(id, source) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, source } : t)) });
  },

  async saveTab(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || !isDirty(tab)) return;
    const source = tab.source;
    try {
      await api.saveRequest(id, source);
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, saved: source } : t)) });
    } catch (error) {
      get().notify(`Couldn't save: ${errorMessage(error)}`, true);
    }
  },

  async run(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.runId) return;
    const runId = crypto.randomUUID();
    const update = (patch: Partial<Tab>) => set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    update({ runId });
    try {
      const result = await api.runRequest(id, tab.source, runId);
      update({ result, runId: null });
    } catch (error) {
      update({ result: { status: null, durationMs: 0, returnValue: null, usageTokens: null, body: "", error: errorMessage(error) }, runId: null });
    }
  },

  cancelRun(id) {
    const runId = get().tabs.find((t) => t.id === id)?.runId;
    if (runId) void api.cancelRun(runId);
  },

  async refreshNetworks() {
    const networks = await Promise.all(get().tabs.map((t) => api.resolveNetwork(t.id).catch(() => t.network)));
    const ids = get().tabs.map((t) => t.id);
    set({ tabs: get().tabs.map((t) => (ids.includes(t.id) ? { ...t, network: networks[ids.indexOf(t.id)] } : t)) });
    for (const network of networks) if (network) void get().loadCatalog(network.registryUrl);
  },

  async loadCatalog(registryUrl, refresh = false) {
    const current = get().catalogs[registryUrl];
    if (!refresh && current?.catalog && !current.catalog.stale) return current.catalog;
    const key = `${registryUrl} ${refresh}`;
    let request = catalogRequests.get(key);
    if (!request) {
      const empty: CatalogState = { catalog: null, error: null, loading: false };
      const setCatalog = (patch: Partial<CatalogState>) =>
        set({ catalogs: { ...get().catalogs, [registryUrl]: { ...(get().catalogs[registryUrl] ?? empty), ...patch } } });
      setCatalog({ loading: true });
      request = api
        .getCatalog(registryUrl, refresh)
        .then((catalog) => {
          setCatalog({ catalog, error: null, loading: false });
          return catalog;
        })
        .catch((error) => {
          setCatalog({ error: errorMessage(error), loading: false });
          return null;
        })
        .finally(() => catalogRequests.delete(key));
      catalogRequests.set(key, request);
    }
    return request;
  },

  async refreshResources(registryUrl) {
    // The backend drops its cached details once the catalog refetches, so clear ours after that.
    await get().loadCatalog(registryUrl, true);
    for (const key of detailRequests.keys()) if (key.startsWith(`${registryUrl} `)) detailRequests.delete(key);
    set({ resourcesRevision: get().resourcesRevision + 1 });
  },

  setDialog(dialog) {
    set({ dialog });
  },

  setRenaming(id) {
    set({ renamingId: id });
  },

  notify(message, error = false) {
    set({ toast: { message, error } });
    setTimeout(() => {
      if (get().toast?.message === message) set({ toast: null });
    }, error ? 6000 : 3000);
  },

  toggleBrowser() {
    set({ browserOpen: !get().browserOpen });
  },

  async checkForUpdates(manual = false) {
    if (get().update?.status === "installing") return;
    const update = await checkForUpdate();
    if (!update) {
      if (manual) get().notify("You're on the latest version");
      return;
    }
    if (!manual && update.version === dismissedUpdate()) return;
    void pendingUpdate?.close();
    pendingUpdate = update;
    set({ update: { version: update.version, status: "available", progress: null, error: null } });
  },

  installUpdate() {
    const update = pendingUpdate;
    if (!update || get().update?.status === "installing") return;
    const install = async () => {
      const patch = (p: Partial<UpdateState>) => {
        const current = get().update;
        if (current) set({ update: { ...current, ...p } });
      };
      patch({ status: "installing", progress: null, error: null });
      try {
        await installAndRelaunch(update, (progress) => patch({ progress }));
      } catch (error) {
        patch({ status: "error", error: errorMessage(error) });
      }
    };
    const unsaved = get().tabs.filter(isDirty);
    if (!unsaved.length) return void install();
    get().setDialog({
      kind: "confirm",
      title: "Restart to update?",
      message: `${unsaved.length === 1 ? "1 request has" : `${unsaved.length} requests have`} unsaved changes that will be lost when the app restarts.`,
      confirmLabel: "Discard and update",
      onConfirm: () => void install(),
    });
  },

  dismissUpdate() {
    const version = get().update?.version;
    set({ update: null });
    try {
      if (version) localStorage.setItem(DISMISSED_UPDATE_KEY, version);
    } catch {
      // Then the next check offers it again, which is fine.
    }
  },
}));
