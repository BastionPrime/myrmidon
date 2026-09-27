/**
 * myrmidon(M1): models from the agent card go into the config.yaml of one
 * run, never into the agent's persistent Hermes profile.
 *
 * Card fields (adapterConfig):
 *   model                       -> model.default
 *   models.vision               -> auxiliary.vision.model
 *   models.stt                  -> stt.<stt.provider>.model
 *   models.tts                  -> tts.<tts.provider>.model
 *   models.fallbacks[]          -> fallback_model (chain of {provider, model})
 *   effort (vendor thinking UI) -> agent.reasoning_effort
 *   models.video                -> not supported by Hermes: warning only
 *
 * Rules: an empty field leaves the profile value alone; the persistent profile
 * is never written; a field Hermes cannot take produces a run-log warning and
 * the run still starts. Only model names are written: no keys, no URLs.
 *
 * The adapter package ships no YAML library, so edits are line-oriented and
 * limited to block mappings with two-space indentation (what Hermes itself
 * writes). Any other shape is left untouched with a warning.
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export interface HermesCardModels {
  text?: string;
  vision?: string;
  video?: string;
  stt?: string;
  tts?: string;
  fallbacks?: string[];
  reasoningEffort?: string;
}

const INDENT = "  ";
const RUN_HOME_PREFIX = "paperclip-hermes-models-";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read the M1 fields from adapterConfig. */
export function readHermesCardModels(config: Record<string, unknown>): HermesCardModels {
  const models =
    typeof config.models === "object" && config.models !== null && !Array.isArray(config.models)
      ? (config.models as Record<string, unknown>)
      : {};
  const fallbacks = Array.isArray(models.fallbacks)
    ? models.fallbacks.map(nonEmptyString).filter((item): item is string => Boolean(item))
    : [];
  return {
    text: nonEmptyString(config.model),
    vision: nonEmptyString(models.vision),
    video: nonEmptyString(models.video),
    stt: nonEmptyString(models.stt),
    tts: nonEmptyString(models.tts),
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
    reasoningEffort: nonEmptyString(config.effort) ?? nonEmptyString(models.reasoningEffort),
  };
}

export function hasHermesCardModels(models: HermesCardModels): boolean {
  return Object.values(models).some((value) => value !== undefined);
}

// ---------------------------------------------------------------------------
// Line-oriented YAML block editing
// ---------------------------------------------------------------------------

class UnsupportedYamlShape extends Error {}

function yamlScalar(value: string): string {
  // JSON string escaping is valid YAML double-quoted escaping.
  return JSON.stringify(value);
}

function isContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function keyPattern(key: string, depth: number): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${INDENT.repeat(depth)}["']?${escaped}["']?[ \\t]*:(.*)$`);
}

/** End (exclusive) of the block that starts at `start` with indent `indent`. */
function blockEnd(lines: string[], start: number, indent: number): number {
  let end = start + 1;
  let lastContent = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end]!;
    if (!isContentLine(line)) continue;
    const lineIndent = indentOf(line);
    // PyYAML writes sequence items at the parent key's indent.
    const sequenceItem = lineIndent === indent && /^-(\s|$)/.test(line.trimStart());
    if (lineIndent < indent || (lineIndent === indent && !sequenceItem)) break;
    lastContent = end;
  }
  return lastContent + 1;
}

function inlineValue(rest: string): string {
  return (rest.split(" #")[0] ?? "").trim();
}

/**
 * Locate (or create) the mapping at `keys` and return the index range of its
 * children. Throws UnsupportedYamlShape on flow style, scalars in the way, or
 * foreign indentation.
 */
function ensureMapping(lines: string[], keys: string[]): { start: number; end: number } {
  let rangeStart = 0;
  let rangeEnd = lines.length;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const key = keys[depth]!;
    const pattern = keyPattern(key, depth);
    let found = -1;
    for (let i = rangeStart; i < rangeEnd; i += 1) {
      const line = lines[i]!;
      if (!isContentLine(line)) continue;
      if (indentOf(line) !== depth * INDENT.length) {
        if (indentOf(line) < depth * INDENT.length) break;
        continue;
      }
      if (pattern.test(line)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      const insertAt = rangeEnd;
      lines.splice(insertAt, 0, `${INDENT.repeat(depth)}${key}:`);
      rangeStart = insertAt + 1;
      rangeEnd = insertAt + 1;
      continue;
    }
    const value = inlineValue(pattern.exec(lines[found]!)![1] ?? "");
    if (value.length > 0 && value !== "{}" && value !== "null" && value !== "~") {
      throw new UnsupportedYamlShape(`${keys.slice(0, depth + 1).join(".")} is not a block mapping`);
    }
    if (value.length > 0) lines[found] = `${INDENT.repeat(depth)}${key}:`;
    const end = blockEnd(lines, found, depth * INDENT.length);
    const firstChild = lines.slice(found + 1, end).find(isContentLine);
    if (firstChild !== undefined && indentOf(firstChild) !== (depth + 1) * INDENT.length) {
      throw new UnsupportedYamlShape(`${keys.slice(0, depth + 1).join(".")} is not a two-space block mapping`);
    }
    rangeStart = found + 1;
    rangeEnd = end;
  }
  return { start: rangeStart, end: rangeEnd };
}

/** Set `keys` (leaf last) to a string scalar, keeping sibling keys. */
function setScalar(lines: string[], keys: string[], value: string): void {
  const parent = ensureMapping(lines, keys.slice(0, -1));
  const depth = keys.length - 1;
  const leaf = keys[keys.length - 1]!;
  const pattern = keyPattern(leaf, depth);
  const rendered = `${INDENT.repeat(depth)}${leaf}: ${yamlScalar(value)}`;
  for (let i = parent.start; i < parent.end; i += 1) {
    const line = lines[i]!;
    if (!isContentLine(line) || indentOf(line) !== depth * INDENT.length) continue;
    if (!pattern.test(line)) continue;
    const end = blockEnd(lines, i, depth * INDENT.length);
    lines.splice(i, end - i, rendered);
    return;
  }
  lines.splice(parent.end, 0, rendered);
}

/** Read a top-level-rooted string scalar, or undefined. */
function getScalar(lines: string[], keys: string[]): string | undefined {
  let rangeStart = 0;
  let rangeEnd = lines.length;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const pattern = keyPattern(keys[depth]!, depth);
    let found = -1;
    for (let i = rangeStart; i < rangeEnd; i += 1) {
      const line = lines[i]!;
      if (!isContentLine(line) || indentOf(line) !== depth * INDENT.length) continue;
      if (pattern.test(line)) {
        found = i;
        break;
      }
    }
    if (found === -1) return undefined;
    const value = inlineValue(pattern.exec(lines[found]!)![1] ?? "");
    if (depth === keys.length - 1) {
      if (!value) return undefined;
      return value.replace(/^["']|["']$/g, "") || undefined;
    }
    if (value) return undefined;
    rangeStart = found + 1;
    rangeEnd = blockEnd(lines, found, depth * INDENT.length);
  }
  return undefined;
}

/** Replace the whole top-level block `key` with `blockLines`. */
function replaceTopLevelBlock(lines: string[], key: string, blockLines: string[]): void {
  const pattern = keyPattern(key, 0);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push(...blockLines);
    return;
  }
  const end = blockEnd(lines, start, 0);
  lines.splice(start, end - start, ...blockLines);
}

// ---------------------------------------------------------------------------
// Apply card models to a config.yaml text
// ---------------------------------------------------------------------------

export interface ApplyCardModelsResult {
  configYaml: string;
  applied: string[];
  warnings: string[];
}

const HERMES_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Write the card models into a config.yaml text. `provider` is the provider
 * the run resolved (used for the fallback chain, which Hermes requires to
 * carry a provider per entry).
 */
export function applyCardModelsToConfigYaml(
  configYaml: string,
  models: HermesCardModels,
  options: { provider?: string } = {},
): ApplyCardModelsResult {
  const lines = configYaml.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  const applied: string[] = [];
  const warnings: string[] = [];

  const attempt = (field: string, fn: () => void) => {
    const snapshot = [...lines];
    try {
      fn();
      applied.push(field);
    } catch (err) {
      lines.splice(0, lines.length, ...snapshot);
      if (err instanceof UnsupportedYamlShape) {
        warnings.push(`${field}: profile config.yaml shape not supported (${err.message}); profile value kept`);
        return;
      }
      throw err;
    }
  };

  if (models.text) attempt("model.default", () => setScalar(lines, ["model", "default"], models.text!));
  if (models.vision) {
    attempt("auxiliary.vision.model", () => setScalar(lines, ["auxiliary", "vision", "model"], models.vision!));
  }
  for (const [field, section] of [
    ["stt", "stt"],
    ["tts", "tts"],
  ] as const) {
    const model = models[field];
    if (!model) continue;
    const sectionProvider = getScalar(lines, [section, "provider"]);
    if (!sectionProvider) {
      warnings.push(
        `${section}: the profile sets no ${section}.provider, so the ${field} model "${model}" cannot be placed; profile value kept`,
      );
      continue;
    }
    attempt(`${section}.${sectionProvider}.model`, () => setScalar(lines, [section, sectionProvider, "model"], model));
  }
  if (models.fallbacks?.length) {
    const provider =
      [options.provider, getScalar(lines, ["model", "provider"])].find(
        (candidate) => candidate && candidate !== "auto",
      ) ?? undefined;
    if (!provider) {
      warnings.push(
        "fallback_model: no explicit provider (card and profile use auto); Hermes needs a provider per fallback entry, profile value kept",
      );
    } else {
      attempt("fallback_model", () =>
        replaceTopLevelBlock(lines, "fallback_model", [
          "fallback_model:",
          ...models.fallbacks!.flatMap((model) => [
            `${INDENT}- provider: ${yamlScalar(provider)}`,
            `${INDENT}  model: ${yamlScalar(model)}`,
          ]),
        ]),
      );
    }
  }
  if (models.reasoningEffort) {
    const effort = models.reasoningEffort.toLowerCase();
    if (!HERMES_REASONING_EFFORTS.includes(effort)) {
      warnings.push(`agent.reasoning_effort: "${models.reasoningEffort}" is not a Hermes effort level; profile value kept`);
    } else {
      attempt("agent.reasoning_effort", () => setScalar(lines, ["agent", "reasoning_effort"], effort));
    }
  }
  if (models.video) {
    warnings.push(`video model "${models.video}": Hermes has no separate video model setting; not applied`);
  }

  return { configYaml: `${lines.join("\n")}\n`, applied, warnings };
}

// ---------------------------------------------------------------------------
// Run-scoped Hermes home
// ---------------------------------------------------------------------------

export interface HermesRunModelsMaterialization {
  /** HERMES_HOME the run must use (unchanged when already run-scoped). */
  hermesHome: string;
  applied: string[];
  warnings: string[];
  cleanup: () => Promise<void>;
}

async function linkProfileIntoRunHome(realHome: string, runId: string): Promise<{ runHome: string; cleanup: () => Promise<void> }> {
  const token = runId.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || "run";
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), `${RUN_HOME_PREFIX}${token}-`));
  const cleanup = async () => {
    if (!tempRoot.startsWith(path.join(tmpdir(), RUN_HOME_PREFIX))) return;
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const resolvedRealHome = path.resolve(realHome);
    // Keep the `<root>/profiles/<name>` shape Hermes derives the profile from.
    const runHome =
      path.basename(path.dirname(resolvedRealHome)) === "profiles"
        ? path.join(tempRoot, "profiles", path.basename(resolvedRealHome))
        : tempRoot;
    await fs.mkdir(runHome, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(resolvedRealHome).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === "config.yaml") continue;
      await fs.symlink(path.join(resolvedRealHome, entry), path.join(runHome, entry)).catch(() => undefined);
    }
    return { runHome, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Apply the card models to this run's config.yaml. When `runScopedHome` is
 * true, `hermesHome` already is a private per-run copy (P4) and its
 * config.yaml is edited in place; otherwise a run-scoped home is created next
 * to the profile. Returns null when the card sets no models.
 */
export async function materializeHermesRunModels(input: {
  config: Record<string, unknown>;
  hermesHome: string | undefined;
  homeDir: string | undefined;
  runScopedHome: boolean;
  runId: string;
  provider?: string;
  onLog?: LogFn;
}): Promise<HermesRunModelsMaterialization | null> {
  const models = readHermesCardModels(input.config);
  if (!hasHermesCardModels(models)) return null;
  const log: LogFn = input.onLog ?? (async () => undefined);

  const profileHome =
    (input.hermesHome ?? "").trim() || (input.homeDir ? path.join(input.homeDir, ".hermes") : "");
  if (!profileHome) {
    await log("stdout", "[hermes] Warning: card models not applied: neither HERMES_HOME nor HOME is set for this run.\n");
    return null;
  }

  let runHome = profileHome;
  let cleanup = async () => undefined as void;
  if (!input.runScopedHome) {
    const linked = await linkProfileIntoRunHome(profileHome, input.runId);
    runHome = linked.runHome;
    cleanup = linked.cleanup;
  }

  try {
    const sourceConfigPath = path.join(input.runScopedHome ? runHome : profileHome, "config.yaml");
    const configYaml = await fs.readFile(sourceConfigPath, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err?.code === "ENOENT") return "";
      throw err;
    });
    const result = applyCardModelsToConfigYaml(configYaml, models, { provider: input.provider });
    const targetPath = path.join(runHome, "config.yaml");
    // A run-scoped config.yaml is a private copy; never write through a link
    // into the persistent profile.
    await fs.rm(targetPath, { force: true });
    await fs.writeFile(targetPath, result.configYaml, { encoding: "utf8", mode: 0o600 });

    for (const warning of result.warnings) {
      await log("stdout", `[hermes] Warning: ${warning}.\n`);
    }
    if (result.applied.length > 0) {
      await log("stdout", `[hermes] Card models applied to this run's config.yaml: ${result.applied.join(", ")}.\n`);
    }
    return { hermesHome: runHome, applied: result.applied, warnings: result.warnings, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
