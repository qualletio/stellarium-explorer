/**
 * RequestScript for CodeMirror: highlighting and brace-based indentation.
 * The keyword and type sets and the `${}` handling follow requestscript-web's highlighter.
 */
import { HighlightStyle, LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { KEYWORDS, TYPES } from "./analysis";

const KEYWORD_SET = new Set<string>(KEYWORDS);
const TYPE_SET = new Set<string>(TYPES);

type Expect = "none" | "declName" | "typeColon" | "type";

interface State {
  /** Inside a string literal (strings are single-line). */
  inString: boolean;
  /** Brace depths at which open `${` interpolations began. */
  interpolations: number[];
  /** Open bracket depth, for indentation. */
  depth: number;
  /** Tracks `const|var name: Type` so the type is highlighted as one. */
  expect: Expect;
}

function tokenString(stream: StringStream, state: State): string {
  if (stream.match("${")) {
    state.inString = false;
    state.interpolations.push(state.depth);
    return "processingInstruction";
  }
  while (!stream.eol()) {
    // Stop before an interpolation; the next call emits it.
    if (stream.match("${", false)) return "string";
    const ch = stream.next();
    if (ch === "\\") stream.next();
    else if (ch === '"') {
      state.inString = false;
      return "string";
    }
  }
  // An unterminated string ends with the line.
  state.inString = false;
  return "string";
}

const requestScript = StreamLanguage.define<State>({
  name: "requestscript",
  startState: () => ({ inString: false, interpolations: [], depth: 0, expect: "none" }),
  copyState: (s) => ({ ...s, interpolations: [...s.interpolations] }),

  token(stream, state) {
    if (state.inString) return tokenString(stream, state);
    if (stream.sol() && state.expect === "type") state.expect = "none";
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.eat('"')) {
      state.inString = true;
      return "string";
    }

    const expect = state.expect;
    state.expect = "none";

    if (expect === "type") {
      if (stream.match(/^(?:\[\])*[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*/)) return "typeName";
    }
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";

    const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (word) {
      const text = word[0];
      if (KEYWORD_SET.has(text)) {
        if (text === "const" || text === "var") state.expect = "declName";
        if (text === "true" || text === "false") return "bool";
        if (text === "null") return "null";
        return "keyword";
      }
      if (TYPE_SET.has(text)) return "typeName";
      if (expect === "declName") {
        state.expect = "typeColon";
        return "definition(variableName)";
      }
      if (stream.match(/^\s*\(/, false)) return "function(propertyName)";
      if (stream.match(/^\s*:/, false)) return "propertyName";
      return "variableName";
    }

    const ch = stream.next() as string;
    if (ch === ":" && expect === "typeColon") {
      state.expect = "type";
      return "punctuation";
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      state.depth++;
      return "bracket";
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      const interpolation = state.interpolations[state.interpolations.length - 1];
      if (ch === "}" && interpolation === state.depth) {
        state.interpolations.pop();
        state.inString = true;
        return "processingInstruction";
      }
      state.depth = Math.max(0, state.depth - 1);
      return "bracket";
    }
    if (/[=!<>&|+\-*/]/.test(ch)) {
      stream.eatWhile(/[=&|]/);
      return "operator";
    }
    return "punctuation";
  },

  indent(state, textAfter, context) {
    const closing = /^\s*[}\])]/.test(textAfter) ? 1 : 0;
    return Math.max(0, state.depth - closing) * context.unit;
  },

  languageData: {
    commentTokens: { line: "//" },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  },

  tokenTable: {
    "definition(variableName)": tags.definition(tags.variableName),
    "function(propertyName)": tags.function(tags.propertyName),
    processingInstruction: tags.processingInstruction,
  },
});

/** Colors come from CSS custom properties, so the editor follows the app theme. */
export const requestScriptHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [tags.bool, tags.null], color: "var(--syn-keyword)" },
  { tag: tags.typeName, color: "var(--syn-type)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.lineComment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.definition(tags.variableName), color: "var(--syn-definition)" },
  { tag: tags.function(tags.propertyName), color: "var(--syn-function)" },
  { tag: tags.propertyName, color: "var(--syn-property)" },
  { tag: [tags.operator, tags.processingInstruction], color: "var(--syn-operator)" },
  { tag: [tags.punctuation, tags.bracket], color: "var(--syn-punct)" },
]);

export function requestScriptLanguage() {
  return new LanguageSupport(requestScript);
}
