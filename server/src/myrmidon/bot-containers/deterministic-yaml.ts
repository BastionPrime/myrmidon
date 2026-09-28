// myrmidon(G2): a small, deterministic YAML writer for the compiled Hermes
// profile. Not a general-purpose YAML library: it covers exactly the subset
// block mappings, block sequences of scalars or flat mappings, string,
// number and boolean scalars — that a Hermes config.yaml needs. Mapping keys
// are always emitted in sorted order so two calls with the same logical
// input produce byte-identical output.
//
// String scalars are always double-quoted (JSON-style escaping, which is
// valid YAML double-quoted escaping). This sidesteps YAML 1.1 plain-scalar
// resolution entirely: PyYAML's default loader reads unquoted `off`, `on`,
// `yes`, `no` as booleans, and `null`/`~` as null, which would silently
// corrupt values such as `approvals.mode: off`.

export type YamlScalar = string | number | boolean;
export type YamlNode = YamlScalar | undefined | readonly YamlNode[] | { readonly [key: string]: YamlNode };
export type YamlMapping = { readonly [key: string]: YamlNode };

const BARE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function isPlainObject(value: YamlNode): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderScalar(value: YamlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) {
    throw new Error(`deterministic-yaml: refusing to render non-finite number ${String(value)}`);
  }
  return String(value);
}

function renderKey(key: string): string {
  return BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

function sortedDefinedEntries(mapping: YamlMapping): Array<[string, YamlNode]> {
  return Object.keys(mapping)
    .filter((key) => mapping[key] !== undefined)
    .sort()
    .map((key): [string, YamlNode] => [key, mapping[key] as YamlNode]);
}

/** Render a mapping's entries as lines at `indent` spaces, appended to `lines`. */
function renderMapping(mapping: YamlMapping, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const [key, value] of sortedDefinedEntries(mapping)) {
    if (isPlainObject(value)) {
      const nested: string[] = [];
      renderMapping(value, indent + 2, nested);
      if (nested.length === 0) continue; // an empty nested group is dropped, not written as `key: {}`
      lines.push(`${pad}${renderKey(key)}:`);
      lines.push(...nested);
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue; // an empty list is dropped, not written as `key: []`
      lines.push(`${pad}${renderKey(key)}:`);
      renderSequence(value, indent, lines);
    } else if (value !== undefined) {
      lines.push(`${pad}${renderKey(key)}: ${renderScalar(value)}`);
    }
  }
}

/**
 * Render a block sequence at `indent` spaces — the same column as the key
 * that introduced it, which is the indentation PyYAML itself produces for a
 * block-style dump (`foo:\n- a\n- b`, not `foo:\n  - a`). Both are valid
 * YAML; this one needs no extra bookkeeping for the dash column.
 */
function renderSequence(items: readonly YamlNode[], indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const item of items) {
    if (item === undefined) continue;
    if (Array.isArray(item)) {
      throw new Error("deterministic-yaml: nested sequences are not supported");
    }
    if (isPlainObject(item)) {
      const nested: string[] = [];
      renderMapping(item, indent + 2, nested);
      if (nested.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const [first, ...rest] = nested;
      // Splice the first mapping line into the "- " marker so continuation
      // keys line up under it, e.g.:
      //   - provider: "x"
      //     model: "y"
      lines.push(`${pad}- ${first!.slice(indent + 2)}`);
      lines.push(...rest);
    } else {
      lines.push(`${pad}- ${renderScalar(item)}`);
    }
  }
}

/** Render a full YAML document (a top-level mapping) as text, keys sorted at every level. */
export function writeYamlDocument(root: YamlMapping): string {
  const lines: string[] = [];
  renderMapping(root, 0, lines);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
