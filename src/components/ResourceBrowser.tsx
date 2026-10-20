import { useEffect, useState } from "react";
import { api, errorMessage, type Page, type ResourceDetail, type ResourceSummary, type SearchField } from "../api";
import { findVariables } from "../editor/analysis";
import { formatFunctionPrice, formatResourcePrice, signature } from "../format";
import { resourceDetail, useStore } from "../store";
import { editorViews } from "./Editor";
import { Icon } from "./Icon";

/** The registry for the active request, or else the active workspace's. */
function useRegistryUrl(): string | null {
  const tabNetwork = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.network ?? null);
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const tree = useStore((s) => s.tree);
  const [workspaceRegistry, setWorkspaceRegistry] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return setWorkspaceRegistry(null);
    api
      .resolveNetwork(workspaceId)
      .then((n) => setWorkspaceRegistry(n.registryUrl))
      .catch(() => setWorkspaceRegistry(null));
  }, [workspaceId, tree]);
  return tabNetwork?.registryUrl ?? workspaceRegistry;
}

/** `com.example.Weather` binds as `weather`, avoiding names the script already uses. */
function bindingName(resource: string, taken: string[]): string {
  const base = resource.charAt(0).toLowerCase() + resource.slice(1);
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}${n}`;
  return name;
}

/** Inserts `const name: fqn` on a new line after the request's opening brace. */
function insertBinding(detail: ResourceDetail) {
  const { activeTabId, notify } = useStore.getState();
  const view = activeTabId ? editorViews.get(activeTabId) : undefined;
  if (!view) return notify("Open a request to insert a resource", true);
  const doc = view.state.doc.toString();
  const name = bindingName(detail.name, findVariables(doc));
  const brace = doc.indexOf("{");
  const at = brace === -1 ? view.state.selection.main.head : brace + 1;
  const insert = `\n    const ${name}: ${detail.fqn}`;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  view.focus();
}

function Detail({ registryUrl, fqn, onBack }: { registryUrl: string; fqn: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasEditor = useStore((s) => s.activeTabId !== null);
  const revision = useStore((s) => s.resourcesRevision);

  useEffect(() => {
    setDetail(null);
    setError(null);
    resourceDetail(registryUrl, fqn).then((d) => (d ? setDetail(d) : setError("Couldn't load this resource")));
  }, [registryUrl, fqn, revision]);

  return (
    <div className="resource-detail">
      <button className="link-button" onClick={onBack}>
        ← Results
      </button>
      {error && <p className="form-error">{error}</p>}
      {!detail && !error && <p className="muted">Loading…</p>}
      {detail && (
        <>
          <h3>{detail.name}</h3>
          <code className="fqn">{detail.fqn}</code>
          {detail.removedAt && <p className="form-error">The registry no longer sees this resource.</p>}
          {detail.description && <p>{detail.description}</p>}
          <dl>
            <dt>Host</dt>
            <dd>{detail.host?.name ?? detail.baseUrl}</dd>
            {detail.website && (
              <>
                <dt>Website</dt>
                <dd>{detail.website}</dd>
              </>
            )}
            {detail.host?.grantEndpoint && (
              <>
                <dt>Grants</dt>
                <dd>{detail.host.grantEndpoint}</dd>
              </>
            )}
          </dl>
          <button className="primary" disabled={!hasEditor} onClick={() => insertBinding(detail)} title={hasEditor ? undefined : "Open a request first"}>
            Insert into request
          </button>
          <h4>Functions</h4>
          <ul className="functions">
            {detail.functions.map((fn) => (
              <li key={fn.name}>
                <code>{signature(fn)}</code>
                <div className="tags">
                  <span className="tag">{formatFunctionPrice(fn)}</span>
                  {fn.kind === "inference" && <span className="tag">Inference</span>}
                  {fn.restricted && <span className="tag warn">Restricted</span>}
                </div>
                {fn.description && <p>{fn.description}</p>}
                {fn.parameters.some((p) => p.description) && (
                  <ul className="params">
                    {fn.parameters.map((p) => (
                      <li key={p.name}>
                        <code>{p.name}</code> {p.description}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ResourceBrowser() {
  const registryUrl = useRegistryUrl();
  const [q, setQ] = useState("");
  const [field, setField] = useState<SearchField>("all");
  const [paid, setPaid] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [inference, setInference] = useState(false);
  const [results, setResults] = useState<ResourceSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const revision = useStore((s) => s.resourcesRevision);
  const refreshing = useStore((s) => (registryUrl ? !!s.catalogs[registryUrl]?.loading : false));

  const search = async (offset: number) => {
    if (!registryUrl) return;
    setLoading(true);
    setError(null);
    try {
      const page: Page<ResourceSummary> = await api.searchResources(registryUrl, {
        q: q.trim() || undefined,
        in: field,
        paid: paid || undefined,
        restricted: restricted || undefined,
        inference: inference || undefined,
        offset,
        limit: 50,
      });
      setResults((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
      setNextOffset(page.nextOffset);
    } catch (e) {
      setError(errorMessage(e));
      if (offset === 0) setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => void search(0), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryUrl, q, field, paid, restricted, inference, revision]);

  useEffect(() => setSelected(null), [registryUrl]);

  return (
    <aside className="browser" aria-label="Resource browser">
      <div className="browser-header">
        <div>
          <h2>Resources</h2>
          <span className="muted registry" title={registryUrl ?? ""}>
            {registryUrl ?? "No registry"}
          </span>
        </div>
        <button
          className={`icon-button${refreshing ? " spinning" : ""}`}
          disabled={!registryUrl || refreshing}
          onClick={() => registryUrl && void useStore.getState().refreshResources(registryUrl)}
          title="Refresh resources and completions"
          aria-label="Refresh resources"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {selected && registryUrl ? (
        <Detail registryUrl={registryUrl} fqn={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <div className="search">
            <Icon name="search" size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search resources" aria-label="Search resources" spellCheck={false} />
          </div>
          <div className="filters">
            <select value={field} onChange={(e) => setField(e.target.value as SearchField)} aria-label="Search in">
              <option value="all">All fields</option>
              <option value="path">Path</option>
              <option value="name">Name</option>
              <option value="function">Function</option>
            </select>
            <label>
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Paid
            </label>
            <label>
              <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Restricted
            </label>
            <label>
              <input type="checkbox" checked={inference} onChange={(e) => setInference(e.target.checked)} /> Inference
            </label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <ul className="results">
            {results.map((r) => (
              <li key={r.fqn}>
                <button onClick={() => setSelected(r.fqn)}>
                  <span className="result-name">{r.name}</span>
                  <span className="result-path">{r.path}</span>
                  {r.description && <span className="result-description">{r.description}</span>}
                  <span className="tags">
                    <span className="tag">{r.functionCount} fn</span>
                    <span className="tag">{formatResourcePrice(r)}</span>
                    {r.inferenceFunctionCount > 0 && <span className="tag">Inference</span>}
                    {r.restrictedFunctionCount > 0 && <span className="tag warn">Restricted</span>}
                    {r.matchedFunctions.map((f) => (
                      <span key={f} className="tag match">
                        {f}()
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!loading && !error && results.length === 0 && registryUrl && <p className="muted center">No resources found</p>}
          {loading && <p className="muted center">Loading…</p>}
          {nextOffset !== null && !loading && (
            <button className="load-more" onClick={() => search(nextOffset)}>
              Load more
            </button>
          )}
        </>
      )}
    </aside>
  );
}
