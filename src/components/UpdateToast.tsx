import { useStore } from "../store";
import { Icon } from "./Icon";

export function UpdateToast() {
  const update = useStore((s) => s.update);
  if (!update) return null;
  const { installUpdate, dismissUpdate } = useStore.getState();
  const installing = update.status === "installing";

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-body">
        <strong>Version {update.version} is available</strong>
        {installing && (
          <span className="update-toast-detail">
            {update.progress === null ? "Downloading…" : update.progress < 1 ? `Downloading… ${Math.round(update.progress * 100)}%` : "Installing…"}
          </span>
        )}
        {update.status === "error" && <span className="update-toast-detail error">Update failed: {update.error}</span>}
        {installing && update.progress !== null && (
          <div className="update-toast-progress" aria-hidden="true">
            <div style={{ width: `${update.progress * 100}%` }} />
          </div>
        )}
      </div>
      {!installing && (
        <div className="update-toast-actions">
          <button onClick={dismissUpdate}>Later</button>
          <button className="primary" onClick={installUpdate}>
            {update.status === "error" ? (
              <>
                <Icon name="refresh" /> Retry
              </>
            ) : (
              "Install & restart"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
