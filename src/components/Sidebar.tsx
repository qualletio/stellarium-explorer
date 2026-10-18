import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, errorMessage, type TreeNode } from "../api";
import { useStore } from "../store";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<TreeNode["kind"], IconName> = { workspace: "workspace", collection: "collection", folder: "folder", request: "request" };

/** Which kinds may be dropped onto which. */
const DROP_TARGETS: Record<TreeNode["kind"], TreeNode["kind"][]> = {
  workspace: [],
  collection: ["workspace"],
  folder: ["collection", "folder"],
  request: ["collection", "folder"],
};

const DRAG_TYPE = "application/x-stellarium-node";
let dragging: TreeNode | null = null;

async function act(action: () => Promise<unknown>) {
  try {
    await action();
    await useStore.getState().loadTree();
  } catch (error) {
    useStore.getState().notify(errorMessage(error), true);
  }
}

const DEFAULT_NAMES = { collection: "New collection", folder: "New folder", request: "New request" };

/** `base`, or `base 2`, `base 3`… if a sibling already has that name. */
function defaultName(siblings: TreeNode[], base: string): string {
  const taken = new Set(siblings.map((n) => n.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Creates a node with a default name and starts renaming it in place. */
async function createNode(kind: keyof typeof DEFAULT_NAMES, parent: TreeNode) {
  const store = useStore.getState();
  const name = defaultName(parent.children, DEFAULT_NAMES[kind]);
  try {
    const id =
      kind === "collection"
        ? await api.createCollection(parent.id, name)
        : kind === "folder"
          ? await api.createFolder(parent.id, name)
          : await api.createRequest(parent.id, name);
    await store.loadTree();
    store.toggleExpanded(parent.id, true);
    if (kind === "request") await store.openRequest(id);
    else store.toggleExpanded(id, true);
    store.setRenaming(id);
  } catch (error) {
    store.notify(errorMessage(error), true);
  }
}

function RenameInput({ node }: { node: TreeNode }) {
  const [name, setName] = useState(node.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // Wait a frame so a request's editor, which focuses when its tab opens, doesn't take focus back.
    const frame = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    useStore.getState().setRenaming(null);
    const trimmed = name.trim();
    if (save && trimmed && trimmed !== node.name) void act(() => api.updateDetails(node.id, trimmed, node.description ?? undefined));
  };

  return (
    <input
      ref={ref}
      className="rename"
      aria-label={`Name of ${node.name}`}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function confirmDelete(node: TreeNode) {
  const what = node.kind === "request" ? "request" : `${node.kind} and everything in it`;
  useStore.getState().setDialog({
    kind: "confirm",
    title: `Delete “${node.name}”?`,
    message: `This deletes the ${what} from disk.`,
    confirmLabel: "Delete",
    onConfirm: () => act(() => api.deleteNode(node.id)),
  });
}

function NodeMenu({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const setDialog = useStore((s) => s.setDialog);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);

  const item = (label: string, icon: IconName, run: () => void) => (
    <button
      role="menuitem"
      onClick={() => {
        onClose();
        run();
      }}
    >
      <Icon name={icon} size={14} /> {label}
    </button>
  );
  const container = node.kind === "collection" || node.kind === "folder";
  return (
    <div className="menu" role="menu" ref={ref}>
      {container && item("New request", "request", () => void createNode("request", node))}
      {container && item("New folder", "folder", () => void createNode("folder", node))}
      {item("Rename", "edit", () => useStore.getState().setRenaming(node.id))}
      {node.kind === "collection" && item("Edit description", "edit", () => setDialog({ kind: "details", mode: "edit", node }))}
      {node.kind !== "folder" && item("Network settings", "network", () => setDialog({ kind: "network", node }))}
      {item("Delete", "trash", () => confirmDelete(node))}
    </div>
  );
}

function NodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useStore((s) => !!s.expanded[node.id]);
  const active = useStore((s) => s.activeTabId === node.id);
  const dirty = useStore((s) => s.tabs.some((t) => t.id === node.id && t.source !== t.saved));
  const renaming = useStore((s) => s.renamingId === node.id);
  const { toggleExpanded, openRequest } = useStore.getState();
  const [menu, setMenu] = useState(false);
  const [dropping, setDropping] = useState(false);
  const isRequest = node.kind === "request";
  const overridesNetwork = !!(node.network?.registryUrl || node.network?.nodeUrl);

  const canDrop = () => !!dragging && dragging.id !== node.id && DROP_TARGETS[dragging.kind].includes(node.kind);
  const onDragOver = (e: DragEvent) => {
    if (!canDrop()) return;
    e.preventDefault();
    e.stopPropagation();
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    if (!canDrop() || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const moved = dragging;
    toggleExpanded(node.id, true);
    void act(() => api.moveNode(moved.id, node.id));
  };

  return (
    <li>
      <div
        className={`row${active ? " active" : ""}${dropping ? " dropping" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          dragging = node;
          e.dataTransfer.setData(DRAG_TYPE, node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => (dragging = null)}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
        onClick={(e) => {
          // The second click of a double-click renames instead.
          if (e.detail > 1) return;
          if (isRequest) void openRequest(node.id);
          else toggleExpanded(node.id);
        }}
        onDoubleClick={() => useStore.getState().setRenaming(node.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        title={node.description}
      >
        <span className={`chevron${expanded ? " open" : ""}`}>{!isRequest && <Icon name="chevron" size={12} />}</span>
        <Icon name={ICONS[node.kind]} size={14} />
        {renaming ? <RenameInput node={node} /> : <span className="label">{node.name}</span>}
        {overridesNetwork && (
          <span className="badge" title="Sets its own network">
            <Icon name="network" size={11} />
          </span>
        )}
        {dirty && <span className="dirty" title="Unsaved changes" />}
        <button
          className="icon-button row-action"
          aria-label={`Actions for ${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="more" />
        </button>
      </div>
      {menu && <NodeMenu node={node} onClose={() => setMenu(false)} />}
      {expanded && !isRequest && (
        <ul>
          {node.children.map((child) => (
            <NodeRow key={child.id} node={child} depth={depth + 1} />
          ))}
          {node.children.length === 0 && (
            <li className="empty-row" style={{ paddingLeft: 8 + (depth + 1) * 14 + 18 }}>
              Empty
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function Sidebar() {
  const tree = useStore((s) => s.tree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const { setActiveWorkspace, setDialog } = useStore.getState();
  const workspace = tree.workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const openFolder = async () => {
    const path = await open({ directory: true, title: "Open a workspace folder" });
    if (typeof path !== "string") return;
    try {
      const id = await api.openWorkspace(path);
      await useStore.getState().loadTree();
      setActiveWorkspace(id);
    } catch (error) {
      useStore.getState().notify(errorMessage(error), true);
    }
  };

  return (
    <aside className="sidebar">
      <div className="workspace-bar">
        <select
          aria-label="Workspace"
          value={activeWorkspaceId ?? ""}
          onChange={(e) => {
            if (e.target.value === "__new") setDialog({ kind: "details", mode: "create", nodeKind: "workspace" });
            else if (e.target.value === "__open") void openFolder();
            else setActiveWorkspace(e.target.value);
          }}
        >
          {!workspace && <option value="">No workspace</option>}
          {tree.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          <option value="__new">New workspace…</option>
          <option value="__open">Open folder…</option>
        </select>
        {workspace && (
          <>
            <button className="icon-button" aria-label="Workspace network settings" title="Network settings" onClick={() => setDialog({ kind: "network", node: workspace })}>
              <Icon name="network" />
            </button>
            <button className="icon-button" aria-label="Workspace details" title="Rename and describe" onClick={() => setDialog({ kind: "details", mode: "edit", node: workspace })}>
              <Icon name="settings" />
            </button>
          </>
        )}
      </div>
      {workspace?.description && <p className="workspace-description">{workspace.description}</p>}

      {workspace ? (
        <>
          <div className="section-header">
            <span>Collections</span>
            <button
              className="icon-button"
              aria-label="New collection"
              title="New collection"
              onClick={() => void createNode("collection", workspace)}
            >
              <Icon name="plus" />
            </button>
          </div>
          <ul
            className="tree"
            onDragOver={(e) => {
              if (dragging?.kind === "collection") e.preventDefault();
            }}
            onDrop={(e) => {
              const moved = dragging;
              if (moved?.kind !== "collection") return;
              e.preventDefault();
              void act(() => api.moveNode(moved.id, workspace.id));
            }}
          >
            {workspace.children.map((node) => (
              <NodeRow key={node.id} node={node} depth={0} />
            ))}
          </ul>
          {workspace.children.length === 0 && (
            <div className="empty-state">
              <p>Collections group related requests and can set their own network.</p>
              <button onClick={() => void createNode("collection", workspace)}>New collection</button>
            </div>
          )}
          <div className="sidebar-footer">
            <button className="link-button" onClick={() => setDialog({
              kind: "confirm",
              title: `Close “${workspace.name}”?`,
              message: "The workspace is removed from this list. Its files stay on disk, and you can open the folder again later.",
              confirmLabel: "Close workspace",
              onConfirm: () => act(() => api.closeWorkspace(workspace.id)),
            })}>
              Close workspace
            </button>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <p>A workspace holds collections of requests, stored as plain files you can version and share.</p>
          <button className="primary" onClick={() => setDialog({ kind: "details", mode: "create", nodeKind: "workspace" })}>
            New workspace
          </button>
          <button onClick={openFolder}>
            <Icon name="open" size={14} /> Open folder
          </button>
        </div>
      )}

      {tree.broken.map((b) => (
        <div className="broken" key={b.path}>
          <p>
            Couldn't load <code>{b.path}</code>: {b.error}
          </p>
          <button className="link-button" onClick={() => act(() => api.forgetWorkspace(b.path))}>
            Remove from list
          </button>
        </div>
      ))}
    </aside>
  );
}
