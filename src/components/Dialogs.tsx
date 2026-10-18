import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage, type KeyUpdate, type NetworkSettings, type NodeKind, type ResolvedNetwork, type ScopeRef, type TreeNode } from "../api";
import { findNode, useStore, type Dialog } from "../store";

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<NodeKind, string> = { workspace: "workspace", collection: "collection", folder: "folder", request: "request" };
const DESCRIBED: NodeKind[] = ["workspace", "collection"];

function DetailsDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "details" }>; onClose: () => void }) {
  const editing = dialog.mode === "edit" ? dialog.node : null;
  const kind = editing?.kind ?? (dialog.mode === "create" ? dialog.nodeKind : "request");
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [location, setLocation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const store = useStore.getState();
    try {
      const desc = DESCRIBED.includes(kind) ? description : undefined;
      if (editing) {
        await api.updateDetails(editing.id, name, desc);
        await store.loadTree();
      } else if (dialog.mode === "create") {
        const parentId = dialog.parentId;
        let id: string;
        if (kind === "workspace") id = await api.createWorkspace(name, desc, location ?? undefined);
        else if (kind === "collection") id = await api.createCollection(parentId!, name, desc);
        else if (kind === "folder") id = await api.createFolder(parentId!, name);
        else id = await api.createRequest(parentId!, name);
        await store.loadTree();
        if (kind === "workspace") store.setActiveWorkspace(id);
        if (parentId) store.toggleExpanded(parentId, true);
        if (kind === "request") await store.openRequest(id);
        if (kind === "collection") store.toggleExpanded(id, true);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${KIND_LABEL[kind]}` : `New ${KIND_LABEL[kind]}`;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {DESCRIBED.includes(kind) && (
          <label>
            Description
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </label>
        )}
        {kind === "workspace" && !editing && (
          <div className="field">
            <span>Location</span>
            <div className="location">
              <code>{location ?? "App data folder"}</code>
              <button
                type="button"
                onClick={async () => {
                  const picked = await open({ directory: true, title: "Choose a folder for the workspace" });
                  if (typeof picked === "string") setLocation(picked);
                }}
              >
                Choose folder…
              </button>
            </div>
            <small>Pick a folder in a git repository to version and share the workspace.</small>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function describeOrigin(from: ScopeRef | null, tree: TreeNode[]): string {
  if (!from) return "Mainnet default";
  const node = findNode(tree, from.id);
  return `From ${KIND_LABEL[from.kind]} “${node?.name ?? "unknown"}”`;
}

function NetworkDialog({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const tree = useStore((s) => s.tree.workspaces);
  const [settings, setSettings] = useState<NetworkSettings | null>(null);
  const [registryUrl, setRegistryUrl] = useState("");
  const [nodeUrl, setNodeUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getNetwork(node.id)
      .then((s) => {
        setSettings(s);
        setRegistryUrl(s.own.registryUrl ?? "");
        setNodeUrl(s.own.nodeUrl ?? "");
      })
      .catch((e) => setError(errorMessage(e)));
  }, [node.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const key: KeyUpdate = apiKey.trim() ? { action: "set", value: apiKey } : clearKey ? { action: "clear" } : { action: "keep" };
    try {
      await api.setNetwork(node.id, { registryUrl, nodeUrl }, key);
      const store = useStore.getState();
      await store.loadTree();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const inherited: ResolvedNetwork | undefined = settings?.inherited;
  const hasKey = !!settings?.own.nodeKey && !clearKey;
  return (
    <Modal title={`Network for “${node.name}”`} onClose={onClose}>
      <p className="hint">
        Leave a field empty to inherit it. Requests use their own settings first, then their collection’s, then their workspace’s.
      </p>
      <form onSubmit={submit}>
        <label>
          Registry API
          <input value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)} placeholder={inherited?.registryUrl ?? "http://localhost:4000/v1"} spellCheck={false} />
          <small>{registryUrl.trim() ? "Used for browsing and autocomplete" : inherited && `${describeOrigin(inherited.registryFrom, tree)}: ${inherited.registryUrl}`}</small>
        </label>
        <label>
          Execution node
          <input value={nodeUrl} onChange={(e) => setNodeUrl(e.target.value)} placeholder={inherited?.nodeUrl ?? "http://localhost:3100"} spellCheck={false} />
          <small>
            {nodeUrl.trim()
              ? "Requests run with POST /v1/run on this node"
              : inherited?.nodeUrl
                ? `${describeOrigin(inherited.nodeFrom, tree)}: ${inherited.nodeUrl}${inherited.nodeKeyScope ? " (with its API key)" : ""}`
                : "No node is set yet, so requests can't run"}
          </small>
        </label>
        <label>
          Node API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? "Saved in the keychain. Type to replace it" : "Optional"}
            disabled={!nodeUrl.trim()}
            autoComplete="off"
          />
          <small>
            {nodeUrl.trim() ? "Kept in the OS keychain, never in workspace files." : "A key belongs to a node. Set a node here to give it a key."}
            {hasKey && !apiKey && (
              <>
                {" "}
                <button type="button" className="link-button" onClick={() => setClearKey(true)}>
                  Remove saved key
                </button>
              </>
            )}
          </small>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !settings}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: "confirm" }>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={dialog.title} onClose={onClose}>
      <p>{dialog.message}</p>
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="danger"
          autoFocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await dialog.onConfirm();
            onClose();
          }}
        >
          {dialog.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.getState().setDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "details":
      return <DetailsDialog dialog={dialog} onClose={close} />;
    case "network":
      return <NetworkDialog node={dialog.node} onClose={close} />;
    case "confirm":
      return <ConfirmDialog dialog={dialog} onClose={close} />;
  }
}
