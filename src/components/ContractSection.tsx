import { useEffect, useState } from "react";
import { api, type ContractInfo, errorMessage } from "../api";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { SourceView } from "./SourceView";

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** The contract's latest version's source comes with its detail; older versions are fetched when picked. */
function useVersionSource(registryUrl: string, fqn: string, contract: ContractInfo, version: string | null) {
  const latest = version !== null && version === contract.latestVersion;
  const [loaded, setLoaded] = useState<{ version: string; source: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (version === null || latest) return;
    let current = true;
    setLoaded(null);
    api
      .getContractVersion(registryUrl, fqn, version)
      .then((v) => current && setLoaded({ version, source: v.source, error: null }))
      .catch((e) => current && setLoaded({ version, source: null, error: errorMessage(e) }));
    return () => {
      current = false;
    };
  }, [registryUrl, fqn, version, latest]);

  if (version === null) return { source: null, error: null, loading: false };
  if (latest) return { source: contract.source, error: null, loading: false };
  if (loaded?.version !== version) return { source: null, error: null, loading: true };
  return { source: loaded.source, error: loaded.error, loading: false };
}

/** A contract's versions, newest first, and one version's RequestScript source. */
export function ContractSection({ registryUrl, fqn, contract }: { registryUrl: string; fqn: string; contract: ContractInfo }) {
  const [shown, setShown] = useState<string | null>(contract.latestVersion);
  useEffect(() => setShown(contract.latestVersion), [fqn, contract.latestVersion]);
  const { source, error, loading } = useVersionSource(registryUrl, fqn, contract, shown);

  const copy = async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      useStore.getState().notify("Copied the contract's source");
    } catch (e) {
      useStore.getState().notify(`Couldn't copy: ${errorMessage(e)}`, true);
    }
  };

  return (
    <div className="contract">
      <h4>Contract</h4>
      <p className="muted">A RequestScript script deployed to its host. Calls run the latest version, and every version's source is public.</p>
      <dl>
        <dt>Latest</dt>
        <dd>{contract.latestVersion ? <code>@{contract.latestVersion}</code> : <span className="muted">Unknown</span>}</dd>
        <dt>Owner</dt>
        <dd>
          {contract.ownerOrganizationId ? (
            <code>{contract.ownerOrganizationId}</code>
          ) : (
            <span className="muted">{contract.versions.length > 0 ? "The host node's admin" : "Unknown"}</span>
          )}
        </dd>
        <dt>Source read</dt>
        <dd>{contract.syncedAt ? formatDate(contract.syncedAt) : <span className="muted">Not yet: the registry hasn't reached the host</span>}</dd>
      </dl>

      {contract.versions.length === 0 ? (
        <p className="muted">
          {contract.syncedAt ? "The host lists no versions of this contract." : "Versions and source appear once the registry reads them from the host."}
        </p>
      ) : (
        <>
          <h4>Versions ({contract.versions.length})</h4>
          <ul className="versions">
            {contract.versions.map((v) => (
              <li key={v.version}>
                <button className={v.version === shown ? "on" : undefined} aria-pressed={v.version === shown} onClick={() => setShown(v.version)}>
                  <span className="version-line">
                    <code>@{v.version}</code>
                    {v.version === contract.latestVersion && <span className="tag match">latest</span>}
                    <span className="muted version-date" title={v.deployedAt}>
                      {formatDate(v.deployedAt)}
                    </span>
                  </span>
                  <code className="version-signature">
                    ({v.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}): {v.returnType}
                  </code>
                  {v.description && <span className="version-description">{v.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {shown && (
        <div className="source-block">
          <div className="source-head">
            <code title={`${fqn}@${shown}`}>
              {fqn}@{shown}
            </code>
            <button className="icon-button" title="Copy source" aria-label="Copy source" disabled={!source} onClick={() => void copy()}>
              <Icon name="copy" size={14} />
            </button>
          </div>
          {shown !== contract.latestVersion && <p className="source-note">Not the version calls run.</p>}
          {loading && <p className="muted">Loading source…</p>}
          {error && <p className="form-error">{error}</p>}
          {source !== null && <SourceView source={source} />}
          {!loading && !error && source === null && <p className="muted">The registry has no source for this version.</p>}
        </div>
      )}
    </div>
  );
}
