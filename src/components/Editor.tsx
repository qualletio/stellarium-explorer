import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { requestScriptEditor } from "../editor/extensions";
import type { ResourceProvider } from "../editor/provider";
import { resourceDetail, useStore } from "../store";

/** Open editors by tab id, so the resource browser can insert into the active one. */
export const editorViews = new Map<string, EditorView>();

function providerFor(tabId: string): ResourceProvider {
  const registry = () => useStore.getState().tabs.find((t) => t.id === tabId)?.network?.registryUrl ?? null;
  return {
    catalog: async () => {
      const url = registry();
      return url ? useStore.getState().loadCatalog(url) : null;
    },
    cachedCatalog: () => {
      const url = registry();
      return url ? (useStore.getState().catalogs[url]?.catalog ?? null) : null;
    },
    resource: async (fqn) => {
      const url = registry();
      return url ? resourceDetail(url, fqn) : null;
    },
  };
}

interface Props {
  tabId: string;
  source: string;
  revision: number;
  visible: boolean;
}

export function Editor({ tabId, source, revision, visible }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const { editSource, saveTab, run } = useStore.getState();
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: source,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (void run(tabId), true) },
              { key: "Mod-s", run: () => (void saveTab(tabId), true), preventDefault: true },
            ]),
          ),
          requestScriptEditor(providerFor(tabId)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) editSource(tabId, update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editorViews.set(tabId, editor);
    return () => {
      editorViews.delete(tabId);
      editor.destroy();
    };
    // The view is created once per tab; later source changes arrive through `revision`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || revision === 0) return;
    const current = editor.state.doc.toString();
    if (current !== source) editor.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    // Only an external change (a new revision) replaces the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    if (visible) view.current?.focus();
  }, [visible]);

  return <div className="editor" ref={host} hidden={!visible} />;
}
