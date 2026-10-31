import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { requestScriptHighlight, requestScriptLanguage } from "../editor/language";

/**
 * Read-only, highlighted RequestScript, such as a contract's source. The source comes from a remote node,
 * and CodeMirror only ever renders it as text.
 */
export function SourceView({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: source,
        extensions: [
          lineNumbers(),
          requestScriptLanguage(),
          syntaxHighlighting(requestScriptHighlight),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorState.tabSize.of(4),
        ],
      }),
    });
    return () => view.destroy();
  }, [source]);

  return <div className="source-view" ref={host} />;
}
