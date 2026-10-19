import { useRef, useState } from "react";
import type { RunResult } from "../api";
import { findNode, isDirty, pathTo, useStore, type Tab } from "../store";
import { Editor } from "./Editor";
import { Icon, StarMark } from "./Icon";

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const { setActiveTab, closeTab, setDialog } = useStore.getState();

  const close = (tab: Tab) => {
    if (!isDirty(tab)) return closeTab(tab.id);
    setDialog({
      kind: "confirm",
      title: `Discard changes to “${tab.name}”?`,
      message: "This request has unsaved changes.",
      confirmLabel: "Discard",
      onConfirm: () => closeTab(tab.id),
    });
  };

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={`tab${tab.id === activeTabId ? " active" : ""}`}
          onClick={() => setActiveTab(tab.id)}
          onAuxClick={(e) => e.button === 1 && close(tab)}
        >
          <span className="label">{tab.name}</span>
          {isDirty(tab) && <span className="dirty" title="Unsaved changes" />}
          <button
            className="icon-button"
            aria-label={`Close ${tab.name}`}
            onClick={(e) => {
              e.stopPropagation();
              close(tab);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function NetworkChips({ tab }: { tab: Tab }) {
  const tree = useStore((s) => s.tree.workspaces);
  const catalog = useStore((s) => (tab.network ? s.catalogs[tab.network.registryUrl] : undefined));
  const { setDialog, refreshResources } = useStore.getState();
  const node = findNode(tree, tab.id);
  const network = tab.network;
  if (!network) return null;

  const registryStatus = catalog?.loading
    ? "Loading resources…"
    : catalog?.error
      ? `Registry unavailable: ${catalog.error}`
      : catalog?.catalog
        ? `${catalog.catalog.items.length} resources${catalog.catalog.stale ? " (offline copy)" : ""}`
        : "";

  return (
    <div className="chips">
      <button className={`chip${catalog?.error ? " warn" : ""}`} title={registryStatus} onClick={() => node && setDialog({ kind: "network", node })}>
        <span className="chip-label">Registry</span>
        {network.registryFrom ? network.registryUrl : "Mainnet"}
      </button>
      <button className={`chip${network.nodeUrl ? "" : " warn"}`} onClick={() => node && setDialog({ kind: "network", node })}>
        <span className="chip-label">Node</span>
        {network.nodeUrl ?? "Not set"}
        {network.nodeKeyScope && <span title="Uses a saved API key"> 🔑</span>}
      </button>
      <button
        className={`icon-button${catalog?.loading ? " spinning" : ""}`}
        disabled={catalog?.loading}
        title={`Reload resources. ${registryStatus}`}
        aria-label="Reload resources"
        onClick={() => refreshResources(network.registryUrl)}
      >
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );
}

function ResultView({ result }: { result: RunResult }) {
  const [view, setView] = useState<"result" | "raw">("result");
  const ok = result.error === null;
  const text = view === "raw" ? result.body : JSON.stringify(result.returnValue, null, 2);
  return (
    <>
      <div className="response-header">
        <span className={`status ${ok ? "ok" : "fail"}`}>{result.status ?? "—"}</span>
        <span className="muted">{result.durationMs} ms</span>
        <div className="segmented">
          <button className={view === "result" ? "on" : ""} onClick={() => setView("result")}>
            Result
          </button>
          <button className={view === "raw" ? "on" : ""} onClick={() => setView("raw")}>
            Raw
          </button>
        </div>
        <button className="icon-button" title="Copy" aria-label="Copy response" onClick={() => navigator.clipboard.writeText(ok || view === "raw" ? text : (result.error ?? ""))}>
          <Icon name="copy" size={14} />
        </button>
      </div>
      {!ok && view === "result" ? <pre className="response-body error">{result.error}</pre> : <pre className="response-body">{text || "(empty)"}</pre>}
    </>
  );
}

function ResponsePanel({ tab }: { tab: Tab }) {
  if (tab.runId) {
    return (
      <div className="response-empty">
        <span className="spinner" /> Running on {tab.network?.nodeUrl}…
      </div>
    );
  }
  if (!tab.result) {
    return (
      <div className="response-empty">
        Press <kbd>⌘</kbd>
        <kbd>Enter</kbd> to run this request.
      </div>
    );
  }
  return <ResultView key={tab.result.durationMs + tab.result.body} result={tab.result} />;
}

export function RequestView() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const tree = useStore((s) => s.tree.workspaces);
  const { run, cancelRun, saveTab } = useStore.getState();
  const [split, setSplit] = useState(0.6);
  const body = useRef<HTMLDivElement>(null);
  const tab = tabs.find((t) => t.id === activeTabId) ?? null;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = body.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.2, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!tab) {
    return (
      <main className="main">
        <TabBar />
        <div className="welcome">
          <StarMark />
          <h1>Stellarium Explorer</h1>
          <p>Open a request from the sidebar, or create one from a collection’s menu.</p>
          <p className="muted">
            <kbd>⌘</kbd>
            <kbd>Enter</kbd> runs a request. <kbd>⌘</kbd>
            <kbd>S</kbd> saves it. <kbd>Ctrl</kbd>
            <kbd>Space</kbd> shows completions.
          </p>
        </div>
      </main>
    );
  }

  const breadcrumb = pathTo(tree, tab.id)
    .slice(1, -1)
    .map((id) => findNode(tree, id)?.name)
    .join(" / ");

  return (
    <main className="main">
      <TabBar />
      <div className="request-header">
        <div className="title">
          {breadcrumb && <span className="muted">{breadcrumb} / </span>}
          <strong>{tab.name}</strong>
        </div>
        <NetworkChips tab={tab} />
        <button onClick={() => saveTab(tab.id)} disabled={!isDirty(tab)} title="Save (⌘S)">
          Save
        </button>
        {tab.runId ? (
          <button className="danger" onClick={() => cancelRun(tab.id)}>
            <Icon name="stop" size={14} /> Cancel
          </button>
        ) : (
          <button className="primary" onClick={() => run(tab.id)} title="Run (⌘Enter)">
            <Icon name="play" size={14} /> Run
          </button>
        )}
      </div>
      <div className="request-body" ref={body}>
        <div className="editor-pane" style={{ flexBasis: `${split * 100}%` }}>
          {tabs.map((t) => (
            <Editor key={t.id} tabId={t.id} source={t.source} revision={t.revision} visible={t.id === tab.id} />
          ))}
        </div>
        <div className="splitter" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
        <section className="response" aria-label="Response">
          <ResponsePanel tab={tab} />
        </section>
      </div>
    </main>
  );
}
