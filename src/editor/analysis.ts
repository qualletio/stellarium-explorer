/**
 * Lightweight, forgiving analysis of RequestScript source for autocomplete and hover.
 * It never throws, since it runs on half-typed code.
 */

export const KEYWORDS = ["request", "contract", "var", "const", "return", "if", "else", "true", "false", "null"] as const;
export const TYPES = ["int32", "int64", "decimal", "boolean", "string", "object"] as const;

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** A `const name: path.to.Resource` declaration. */
export interface Binding {
  name: string;
  fqn: string;
  /** Offsets of the resource path in the source. */
  from: number;
  to: number;
}

export function findBindings(source: string): Binding[] {
  const bindings: Binding[] = [];
  const pattern = new RegExp(`\\bconst\\s+(${IDENT})\\s*:\\s*(${IDENT}(?:\\s*\\.\\s*${IDENT})+)`, "g");
  for (const match of stripCommentsAndStrings(source).matchAll(pattern)) {
    const from = match.index + match[0].lastIndexOf(match[2]);
    bindings.push({ name: match[1], fqn: match[2].replace(/\s+/g, ""), from, to: from + match[2].length });
  }
  return bindings;
}

/** Names declared with `var` or `const`. */
export function findVariables(source: string): string[] {
  const pattern = new RegExp(`\\b(?:var|const)\\s+(${IDENT})`, "g");
  return [...new Set([...stripCommentsAndStrings(source).matchAll(pattern)].map((m) => m[1]))];
}

export type CompletionContext =
  /** Typing a resource type after `const x: `. `typed` may contain dots. */
  | { kind: "resourcePath"; from: number; typed: string }
  /** Typing a function name after `binding.`. */
  | { kind: "member"; from: number; typed: string; binding: Binding }
  /** Typing a named argument inside `binding.fn(`. `used` lists the arguments already given. */
  | { kind: "argument"; from: number; typed: string; binding: Binding; fn: string; used: string[] }
  | { kind: "general"; from: number; typed: string }
  /** Inside a string or comment, or after an unknown object's `.`. */
  | { kind: "none" };

export function completionContext(source: string, pos: number): CompletionContext {
  const before = source.slice(0, pos);
  const scan = scanBrackets(before);
  if (scan.inString || scan.inComment) return { kind: "none" };

  const declaration = new RegExp(`\\bconst\\s+${IDENT}\\s*:\\s*((?:${IDENT}\\.)*(?:${IDENT})?)$`).exec(before);
  if (declaration) return { kind: "resourcePath", from: pos - declaration[1].length, typed: declaration[1] };

  const bindings = findBindings(source);
  const member = new RegExp(`(${IDENT})\\s*\\.\\s*([A-Za-z0-9_]*)$`).exec(before);
  if (member) {
    const binding = bindings.find((b) => b.name === member[1]);
    return binding ? { kind: "member", from: pos - member[2].length, typed: member[2], binding } : { kind: "none" };
  }

  const frame = scan.stack[scan.stack.length - 1];
  if (frame?.bracket === "(") {
    const call = new RegExp(`(${IDENT})\\s*\\.\\s*(${IDENT})\\s*$`).exec(before.slice(0, frame.at));
    const binding = call && bindings.find((b) => b.name === call[1]);
    const argument = /^\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(frame.current);
    if (call && binding && argument) {
      const typed = argument[1] ?? "";
      const used = [...frame.topLevel.matchAll(new RegExp(`(${IDENT})\\s*:`, "g"))].map((m) => m[1]);
      return { kind: "argument", from: pos - typed.length, typed, binding, fn: call[2], used };
    }
  }

  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
  return { kind: "general", from: pos - (word?.[0].length ?? 0), typed: word?.[0] ?? "" };
}

export type Symbol =
  | { kind: "binding"; from: number; to: number; binding: Binding }
  | { kind: "function"; from: number; to: number; binding: Binding; fn: string }
  | { kind: "argument"; from: number; to: number; binding: Binding; fn: string; name: string };

/** What the identifier at `pos` refers to, for hover tooltips. */
export function symbolAt(source: string, pos: number): Symbol | null {
  let from = pos;
  let to = pos;
  while (from > 0 && /\w/.test(source[from - 1])) from--;
  while (to < source.length && /\w/.test(source[to])) to++;
  if (from === to || !/^[A-Za-z_]/.test(source[from])) return null;
  const word = source.slice(from, to);
  const bindings = findBindings(source);

  const owner = new RegExp(`(${IDENT})\\s*\\.\\s*$`).exec(source.slice(0, from));
  if (owner) {
    const binding = bindings.find((b) => b.name === owner[1]);
    return binding ? { kind: "function", from, to, binding, fn: word } : null;
  }
  const binding = bindings.find((b) => b.name === word);
  if (binding) return { kind: "binding", from, to, binding };

  if (/^\s*:/.test(source.slice(to))) {
    const context = completionContext(source, from);
    if (context.kind === "argument") return { kind: "argument", from, to, binding: context.binding, fn: context.fn, name: word };
  }
  return null;
}

interface Frame {
  bracket: "(" | "[" | "{";
  /** Offset of the opening bracket. */
  at: number;
  /** The frame's own text, with nested brackets' contents left out. */
  topLevel: string;
  /** The text since the frame's last top-level comma. */
  current: string;
}

interface BracketScan {
  stack: Frame[];
  inString: boolean;
  inComment: boolean;
}

const CLOSERS: Record<string, Frame["bracket"]> = { ")": "(", "]": "[", "}": "{" };

/** Tracks open brackets through `text`, skipping strings (but not `${}` code) and comments. */
function scanBrackets(text: string): BracketScan {
  const stack: Frame[] = [];
  // Interpolations nest code inside strings: each entry is the stack depth where one began.
  const interpolations: number[] = [];
  let inString = false;
  let inComment = false;
  const append = (ch: string) => {
    const top = stack[stack.length - 1];
    if (top) {
      top.topLevel += ch;
      top.current += ch;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"' || ch === "\n") inString = false;
      else if (ch === "$" && text[i + 1] === "{") {
        inString = false;
        interpolations.push(stack.length);
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      inComment = true;
      continue;
    }
    if (ch === '"') {
      inString = true;
      append('""');
      continue;
    }
    if (ch === "}" && interpolations.length && interpolations[interpolations.length - 1] === stack.length) {
      interpolations.pop();
      inString = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      append(ch);
      stack.push({ bracket: ch, at: i, topLevel: "", current: "" });
      continue;
    }
    if (CLOSERS[ch]) {
      while (stack.length && stack[stack.length - 1].bracket !== CLOSERS[ch]) stack.pop();
      stack.pop();
      append(ch);
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === "," && top) {
      top.topLevel += ch;
      top.current = "";
      continue;
    }
    append(ch);
  }
  return { stack, inString, inComment };
}

/** Blanks comments and string contents (keeping offsets) so regexes only see code. */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let inString = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        out += ch;
      } else out += " ";
      continue;
    }
    if (inString) {
      if (ch === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
        out += "  ";
        i++;
        continue;
      }
      if (ch === '"' || ch === "\n") inString = false;
      out += ch === "\n" ? ch : ch === '"' ? '"' : " ";
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      inComment = true;
      out += " ";
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
