import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { requestScriptCompletion } from "./completion";
import { requestScriptHover } from "./hover";
import { requestScriptHighlight, requestScriptLanguage } from "./language";
import { requestScriptLinter } from "./lint";
import type { ResourceProvider } from "./provider";

/** Everything a RequestScript editor needs: IDE basics plus registry-aware help. */
export function requestScriptEditor(provider: ResourceProvider): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    indentUnit.of("    "),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    requestScriptLanguage(),
    syntaxHighlighting(requestScriptHighlight),
    autocompletion({ override: [requestScriptCompletion(provider)], icons: true }),
    requestScriptLinter(provider),
    lintGutter(),
    requestScriptHover(provider),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
  ];
}
