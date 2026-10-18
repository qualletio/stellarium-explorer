import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { Dialogs } from "./components/Dialogs";
import { Icon } from "./components/Icon";
import { RequestView } from "./components/RequestView";
import { ResourceBrowser } from "./components/ResourceBrowser";
import { Sidebar } from "./components/Sidebar";
import { UpdateToast } from "./components/UpdateToast";
import { useStore } from "./store";
import "./styles.css";

export default function App() {
  const browserOpen = useStore((s) => s.browserOpen);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    const { loadTree } = useStore.getState();
    void loadTree();
    // Workspace files changed outside the app (an editor, git).
    const unlisten = listen("tree-changed", () => void loadTree());
    return () => void unlisten.then((stop) => stop());
  }, []);

  useEffect(() => {
    // Check shortly after launch (not during it), then periodically for long-running sessions.
    const check = () => void useStore.getState().checkForUpdates();
    const first = setTimeout(check, 5000);
    const every = setInterval(check, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  useEffect(() => {
    // Shortcuts that also work when focus isn't in the editor.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
      const { activeTabId, saveTab, run, toggleBrowser } = useStore.getState();
      if (e.key === "s" && activeTabId) {
        e.preventDefault();
        void saveTab(activeTabId);
      } else if (e.key === "Enter" && activeTabId) {
        e.preventDefault();
        void run(activeTabId);
      } else if (e.key === "b" && e.shiftKey) {
        e.preventDefault();
        toggleBrowser();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app${browserOpen ? "" : " browser-closed"}`}>
      <Sidebar />
      <RequestView />
      {browserOpen && <ResourceBrowser />}
      <button
        className="icon-button browser-toggle"
        onClick={() => useStore.getState().toggleBrowser()}
        title={`${browserOpen ? "Hide" : "Show"} resources (⇧⌘B)`}
        aria-label="Toggle resource browser"
        aria-pressed={browserOpen}
      >
        <Icon name="panel" />
      </button>
      <Dialogs />
      <UpdateToast />
      {toast && (
        <div className={`toast${toast.error ? " error" : ""}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
