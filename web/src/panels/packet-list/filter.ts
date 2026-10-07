import type { QueryCellValue } from "@zeloscloud/app-extension-sdk";
import type { PacketField, PacketRow } from "./data";
import { IPPROTO_ICMP, IPPROTO_ICMPV6, IPPROTO_TCP, IPPROTO_UDP } from "./dissect";

/**
 * A display filter over the packets the panel has BUFFERED — a tokenizer and a recursive-descent parser
 * producing a predicate, run through the grid's external-filter hooks.
 *
 * Deliberately small. Addresses are compared as TEXT against the strings the row already renders, so there
 * is no address parsing and no IPv6 canonicalization; a field's declared kind exists only to produce a
 * validation message. The scope is the fetched window, which the status strip says out loud.
 *
 * An invalid expression is NOT applied: the caller shows the message and marks the offending token, rather
 * than filtering by the half of the expression that parsed.
 */

/** `tcp.port == 443 && !(ip.addr == 10.0.0.5) || info contains dns`; `and`, `or` and `not` spell the same. */
type Operator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "contains";

type FieldDef =
  | { kind: "presence"; test: (row: PacketRow) => boolean }
  | { kind: "address"; read: (row: PacketRow) => string[] }
  | {
      kind: "number";
      read: (row: PacketRow) => QueryCellValue[];
      /** The IP protocol number the field implies, the way `tcp.port` implies TCP. */
      l4?: number | undefined;
      /** The melted field it reads, when the panel might not be projecting it. */
      needs?: PacketField | undefined;
    }
  | { kind: "text"; read: (row: PacketRow) => string[] };

/** `proto` is a display label and may name the application layer (`V2GTP`), so L4 keys on `ip_proto`. */
function isL4(row: PacketRow, ...protos: number[]): boolean {
  const n = toNumber(row.ipProto);
  return n !== null && protos.includes(n);
}

/**
 * Every field the language has. Bounded by what `meltPacketRows` puts on a row: a test the window cannot
 * answer would silently match nothing, so the field simply does not exist here.
 */
const FIELDS: Record<string, FieldDef> = {
  tcp: { kind: "presence", test: (row) => isL4(row, IPPROTO_TCP) },
  udp: { kind: "presence", test: (row) => isL4(row, IPPROTO_UDP) },
  icmp: { kind: "presence", test: (row) => isL4(row, IPPROTO_ICMP, IPPROTO_ICMPV6) },
  // No IP layer, so no `ip_proto`: the label is all ARP has.
  arp: { kind: "presence", test: (row) => row.proto === "ARP" },
  // The row carries no `ip_version`; a rendered IPv6 literal is the one thing that says so.
  ipv6: { kind: "presence", test: (row) => row.srcIp.includes(":") || row.dstIp.includes(":") },

  "ip.addr": { kind: "address", read: (row) => [row.srcIp, row.dstIp] },
  "ip.src": { kind: "address", read: (row) => [row.srcIp] },
  "ip.dst": { kind: "address", read: (row) => [row.dstIp] },

  "tcp.port": { kind: "number", l4: IPPROTO_TCP, read: (row) => [row.srcPort, row.dstPort] },
  "tcp.srcport": { kind: "number", l4: IPPROTO_TCP, read: (row) => [row.srcPort] },
  "tcp.dstport": { kind: "number", l4: IPPROTO_TCP, read: (row) => [row.dstPort] },
  "udp.port": { kind: "number", l4: IPPROTO_UDP, read: (row) => [row.srcPort, row.dstPort] },
  "udp.srcport": { kind: "number", l4: IPPROTO_UDP, read: (row) => [row.srcPort] },
  "udp.dstport": { kind: "number", l4: IPPROTO_UDP, read: (row) => [row.dstPort] },
  "vlan.id": { kind: "number", needs: "vlan_id", read: (row) => [row.vlanId] },
  "frame.len": { kind: "number", read: (row) => [row.origLen] },

  info: { kind: "text", read: (row) => [row.info] },
};

const COMPARISONS: Record<FieldDef["kind"], readonly Operator[]> = {
  presence: [],
  address: ["==", "!="],
  number: ["==", "!=", "<", "<=", ">", ">="],
  text: ["contains"],
};

type Predicate = (row: PacketRow) => boolean;

type PacketFilter =
  /** `predicate` is null for an empty expression: nothing to apply, and nothing wrong. */
  { ok: true; predicate: Predicate | null } | { ok: false; message: string; start: number; end: number };

/** A parse failure, carrying the span of the token that caused it so the UI can mark it. */
class FilterError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = "FilterError";
  }
}

// ------------------------------------------------------------------ tokenize

type TokenKind = "word" | "number" | "string" | "op" | "and" | "or" | "not" | "(" | ")";

interface Token {
  kind: TokenKind;
  /** The source text, minus a string's quotes. */
  text: string;
  start: number;
  end: number;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** Every operator the language has. A run of their characters that spells none of them is an error. */
const OPERATORS = new Map<string, TokenKind>([
  ["&&", "and"], ["||", "or"], ["!", "not"],
  ["==", "op"], ["!=", "op"], ["<=", "op"], [">=", "op"], ["<", "op"], [">", "op"],
]);
const OPERATOR_CHARS = new Set([...OPERATORS.keys()].join(""));

/** Wireshark's spellings of the connectives, reserved the way it reserves them. */
const KEYWORDS = new Map<string, TokenKind>([["not", "not"], ["and", "and"], ["or", "or"]]);

/** A word ends at whitespace, a paren, a quote or an operator character — so `10.0.0.5` stays one token. */
function isWordChar(ch: string): boolean {
  return !/\s/.test(ch) && ch !== "(" && ch !== ")" && ch !== '"' && !OPERATOR_CHARS.has(ch);
}

/** The longest operator at `i`, two characters before one. */
function operatorToken(text: string, i: number): Token {
  for (const width of [2, 1]) {
    const op = text.slice(i, i + width);
    const kind = OPERATORS.get(op);
    if (kind) return { kind, text: op, start: i, end: i + op.length };
  }
  throw new FilterError(`unexpected "${text[i]}"`, i, i + 1);
}

function stringToken(text: string, i: number): Token {
  const close = text.indexOf('"', i + 1);
  if (close < 0) throw new FilterError("unterminated string", i, text.length);
  return { kind: "string", text: text.slice(i + 1, close), start: i, end: close + 1 };
}

function wordToken(text: string, i: number): Token {
  let end = i;
  while (end < text.length && isWordChar(text[end] ?? "")) end++;
  const word = text.slice(i, end);
  const kind = KEYWORDS.get(word.toLowerCase()) ?? (NUMBER_RE.test(word) ? "number" : "word");
  return { kind, text: word, start: i, end };
}

/** The token that starts at `i`, a non-space character. */
function readToken(text: string, i: number): Token {
  const ch = text[i] ?? "";
  if (ch === "(" || ch === ")") return { kind: ch, text: ch, start: i, end: i + 1 };
  if (ch === '"') return stringToken(text, i);
  if (OPERATOR_CHARS.has(ch)) return operatorToken(text, i);
  return wordToken(text, i);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] ?? "")) {
      i++;
      continue;
    }
    const token = readToken(text, i);
    tokens.push(token);
    i = token.end;
  }
  return tokens;
}

// -------------------------------------------------------------- field tests

function toNumber(value: QueryCellValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compare(operator: Operator, a: number, b: number): boolean {
  if (operator === "==") return a === b;
  if (operator === "!=") return a !== b;
  if (operator === "<") return a < b;
  if (operator === "<=") return a <= b;
  if (operator === ">") return a > b;
  return operator === ">=" && a >= b;
}

/**
 * A field can hold more than one value (`tcp.port` is source OR destination), so `==` means "any matches"
 * and `!=` is its negation — the only reading under which `tcp.port != 80` is not true of every packet
 * that has two ports.
 */
function numberTest(def: Extract<FieldDef, { kind: "number" }>, operator: Operator, literal: number): Predicate {
  return (row) => {
    if (def.l4 !== undefined && !isL4(row, def.l4)) return false;
    const values = def
      .read(row)
      .map(toNumber)
      .filter((value): value is number => value !== null);
    if (operator === "!=") return values.length > 0 && !values.includes(literal);
    return values.some((value) => compare(operator, value, literal));
  };
}

function addressTest(def: Extract<FieldDef, { kind: "address" }>, operator: Operator, literal: string): Predicate {
  return (row) => {
    // A packet with no IP layer renders `""`, not an address. `!=` has to read that as "no such field on
    // this packet" and fail, the way `numberTest` and Wireshark both do — negating a miss instead would
    // make `ip.addr != anything` true of every ARP frame.
    const values = def.read(row).filter((value) => value !== "");
    if (operator === "!=") return values.length > 0 && !values.includes(literal);
    return values.includes(literal);
  };
}

function textTest(def: Extract<FieldDef, { kind: "text" }>, literal: string): Predicate {
  const needle = literal.toLowerCase();
  return (row) => def.read(row).some((value) => value.toLowerCase().includes(needle));
}

// ----------------------------------------------------------------- the parse

function unknownField(token: Token): FilterError {
  // `port` is not a field, but `tcp.port` and `udp.port` are — say which, rather than just "unknown".
  const near = Object.keys(FIELDS).filter((name) => name.endsWith(`.${token.text}`));
  const hint = near.length > 0 ? `. Did you mean ${near.join(" or ")}?` : "";
  return new FilterError(`unknown field "${token.text}"${hint}`, token.start, token.end);
}

/** The field `name` names. */
function lookupField(name: Token): FieldDef {
  if (name.kind !== "word") {
    throw new FilterError(`expected a field name, found "${name.text}"`, name.start, name.end);
  }
  // Own keys only: `FIELDS` is an object literal, so `toString` would otherwise index to a function.
  const def = Object.hasOwn(FIELDS, name.text) ? FIELDS[name.text] : undefined;
  if (!def) throw unknownField(name);
  return def;
}

/** An operator is a comparison token, or the word `contains`. */
function isOperator(token: Token | undefined): boolean {
  if (!token) return false;
  return token.kind === "op" || (token.kind === "word" && token.text.toLowerCase() === "contains");
}

/** The comparison `token` spells, when the field's kind supports it. */
function comparison(name: Token, def: FieldDef, token: Token): Operator {
  if (!isOperator(token)) {
    throw new FilterError(`expected an operator after ${name.text}`, token.start, token.end);
  }
  const operator = (token.kind === "op" ? token.text : "contains") as Operator;
  const allowed = COMPARISONS[def.kind];
  if (!allowed.includes(operator)) {
    throw new FilterError(`${name.text} supports only ${allowed.join(" ")}`, token.start, token.end);
  }
  return operator;
}

/** The test a comparing field makes against the literal in `value`, once its shape fits the field. */
function comparisonTest(
  name: Token,
  def: Exclude<FieldDef, { kind: "presence" }>,
  operator: Operator,
  value: Token,
): Predicate {
  if (def.kind === "number") {
    if (value.kind !== "number") {
      const message = `${name.text} is numeric, and "${value.text}" is not a number`;
      throw new FilterError(message, value.start, value.end);
    }
    return numberTest(def, operator, Number(value.text));
  }
  if (value.kind === "number") {
    // The shape check the whole "type" idea exists for: `ip.addr == 8080` is a mistake worth naming.
    const message = `${name.text} compares as text, and ${value.text} is a number. Quote it to mean text`;
    throw new FilterError(message, value.start, value.end);
  }
  if (value.kind !== "word" && value.kind !== "string") {
    throw new FilterError(`expected a value, found "${value.text}"`, value.start, value.end);
  }
  return def.kind === "address" ? addressTest(def, operator, value.text) : textTest(def, value.text);
}

/**
 * Parse `text` into a predicate over the panel's buffered rows.
 *
 * `available` is what the panel's query is projecting, so a field it is not fetching fails validation
 * instead of quietly matching nothing.
 */
export function parsePacketFilter(text: string, available: ReadonlySet<PacketField>): PacketFilter {
  try {
    const tokens = tokenize(text);
    if (tokens.length === 0) return { ok: true, predicate: null };

    let i = 0;

    function peek(): Token | undefined {
      return tokens[i];
    }

    function end(): FilterError {
      return new FilterError("the expression ends early", text.length, text.length);
    }

    function next(): Token {
      const token = tokens[i];
      if (!token) throw end();
      i++;
      return token;
    }

    function parseTest(): Predicate {
      const name = next();
      const def = lookupField(name);

      if (def.kind === "presence") {
        const after = peek();
        if (after && isOperator(after)) {
          throw new FilterError(`${name.text} is a presence test and takes no operator`, after.start, after.end);
        }
        return def.test;
      }

      if (def.kind === "number" && def.needs !== undefined && !available.has(def.needs)) {
        const message = `${name.text} needs the VLAN column: turn on "Show VLAN" in the panel settings`;
        throw new FilterError(message, name.start, name.end);
      }

      const operator = comparison(name, def, next());
      return comparisonTest(name, def, operator, next());
    }

    function parseUnary(): Predicate {
      const token = peek();
      if (token?.kind === "not") {
        i++;
        const inner = parseUnary();
        return (row) => !inner(row);
      }
      if (token?.kind === "(") {
        i++;
        const inner = parseOr();
        const close = peek();
        if (close?.kind !== ")") throw close ? new FilterError('expected ")"', close.start, close.end) : end();
        i++;
        return inner;
      }
      return parseTest();
    }

    function parseAnd(): Predicate {
      let left = parseUnary();
      while (peek()?.kind === "and") {
        i++;
        const right = parseUnary();
        const previous = left;
        left = (row) => previous(row) && right(row);
      }
      return left;
    }

    function parseOr(): Predicate {
      let left = parseAnd();
      while (peek()?.kind === "or") {
        i++;
        const right = parseAnd();
        const previous = left;
        left = (row) => previous(row) || right(row);
      }
      return left;
    }

    const predicate = parseOr();
    const trailing = peek();
    if (trailing) throw new FilterError(`unexpected "${trailing.text}"`, trailing.start, trailing.end);
    return { ok: true, predicate };
  } catch (error) {
    if (error instanceof FilterError) {
      return { ok: false, message: error.message, start: error.start, end: error.end };
    }
    throw error;
  }
}
