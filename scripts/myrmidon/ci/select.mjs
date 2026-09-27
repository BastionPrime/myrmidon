// Change classification and test selection for the fast PR tier of
// .github/workflows/myrmidon-ci.yml. Pure functions over plain data so they
// can be unit-tested; affected-tests.mjs feeds them the real repository.
//
// Tiers:
//   docs - only Myrmidon docs and our node:test scripts changed: no typecheck,
//          vitest or build.
//   fast - typecheck, build and the tests selected below.
//   full - every test lane (the same as a push to main).

import path from "node:path";

// Changing any of these can affect tests anywhere, so they force the full tier.
export const FULL_TRIGGERS = [
  { pattern: /^pnpm-lock\.yaml$/, reason: "lockfile" },
  { pattern: /^pnpm-workspace\.yaml$/, reason: "workspace layout" },
  { pattern: /^package\.json$/, reason: "root package.json" },
  { pattern: /^\.npmrc$/, reason: "npm settings" },
  { pattern: /^patches\//, reason: "patched dependencies" },
  { pattern: /^tsconfig[^/]*\.json$/, reason: "root TypeScript config" },
  { pattern: /^vitest\.config\.[cm]?[jt]s$/, reason: "root vitest config" },
  { pattern: /^scripts\/[^/]+\.(mjs|js|ts|json)$/, reason: "root build and test scripts" },
  { pattern: /^scripts\/__tests__\//, reason: "root build and test scripts" },
  { pattern: /^\.github\/workflows\/myrmidon-ci\.yml$/, reason: "CI workflow" },
  { pattern: /^scripts\/myrmidon\/ci\//, reason: "CI test selection" },
  { pattern: /^packages\/db\//, reason: "database package" },
  { pattern: /^packages\/shared\//, reason: "shared package" },
  { pattern: /^packages\/plugins\/sdk\//, reason: "plugin SDK" },
  { pattern: /^packages\/paperclip-runner\//, reason: "runner (Rust and TypeScript)" },
  { pattern: /^Dockerfile$/, reason: "Dockerfile" },
];

// Files that cannot change the result of typecheck, vitest or the build.
const LIGHT = [
  /^docs\/myrmidon\//,
  /^scripts\/myrmidon\/(?!ci\/)/,
  /^CLAUDE\.md$/,
  /^NOTICE$/,
  /^\.github\/README\.md$/,
  /^\.gitleaks\.toml$/,
];

// Large packages are never tested whole in the fast tier: only their tests that
// changed or directly import the change. Above this many selected files a
// package gets the full tier instead.
export const SELECTIVE_PACKAGES = ["@paperclipai/server", "@paperclipai/ui", "paperclipai"];
export const MAX_FAST_FILES_PER_PACKAGE = 60;

export function classifyChanges(files, { forceFull = false } = {}) {
  if (forceFull) return { tier: "full", reasons: ["full run requested"] };
  if (files.length === 0) return { tier: "docs", reasons: ["no changed files"] };
  const reasons = new Set();
  for (const file of files) {
    for (const trigger of FULL_TRIGGERS) {
      if (trigger.pattern.test(file)) reasons.add(`${trigger.reason}: ${file}`);
    }
  }
  if (reasons.size > 0) return { tier: "full", reasons: [...reasons] };
  if (files.every((file) => LIGHT.some((pattern) => pattern.test(file)))) {
    return { tier: "docs", reasons: ["only Myrmidon docs and scripts"] };
  }
  return { tier: "fast", reasons: ["affected tests only"] };
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

export function importSpecifiers(source) {
  const out = new Set();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) out.add(match[1]);
  return [...out];
}

function stripExtension(file) {
  return file.replace(/\.(?:d\.ts|tsx?|mts|cts|mjs|cjs|jsx?)$/, "").replace(/\/index$/, "");
}

/** Owning package of a repo-relative path (longest matching directory). */
export function ownerOf(file, packages) {
  let best = null;
  for (const pkg of packages) {
    if (pkg.dir === "" ) continue;
    if (file === pkg.dir || file.startsWith(`${pkg.dir}/`)) {
      if (!best || pkg.dir.length > best.dir.length) best = pkg;
    }
  }
  return best;
}

/**
 * Selects tests for the fast tier.
 *
 * packages:  [{ name, dir, vitestProject: boolean, testScript: string|null }]
 * testFiles: [{ file, source }] every test file in the repository (repo-relative)
 *
 * A test file is selected when it changed itself, when it belongs to a changed
 * package (the whole package is tested, except SELECTIVE_PACKAGES), or when it
 * directly imports a changed package (bare specifier) or a changed module
 * (relative specifier). Transitive effects are left to the full run on main.
 */
export function selectTests(changedFiles, packages, testFiles, { selective = SELECTIVE_PACKAGES } = {}) {
  const changedSet = new Set(changedFiles);
  const changedPackages = new Map();
  const changedModules = new Set();
  for (const file of changedFiles) {
    const pkg = ownerOf(file, packages);
    if (pkg) changedPackages.set(pkg.name, pkg);
    if (/\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/.test(file)) changedModules.add(stripExtension(file));
  }

  const wholePackages = [...changedPackages.values()].filter((pkg) => !selective.includes(pkg.name));
  const wholeNames = new Set(wholePackages.map((pkg) => pkg.name));
  const selected = new Map();
  const add = (pkg, file, why) => {
    if (!pkg) return;
    if (!selected.has(pkg.name)) selected.set(pkg.name, { pkg, files: new Map() });
    selected.get(pkg.name).files.set(file, why);
  };

  for (const { file, source } of testFiles) {
    const pkg = ownerOf(file, packages);
    if (!pkg || wholeNames.has(pkg.name)) continue;
    if (changedSet.has(file)) {
      add(pkg, file, "changed");
      continue;
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        const target = stripExtension(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
        if (changedModules.has(target)) {
          add(pkg, file, `imports ${target}`);
          break;
        }
      } else {
        const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (changedPackages.has(bare) && bare !== pkg.name) {
          add(pkg, file, `imports ${bare}`);
          break;
        }
      }
    }
  }

  return {
    wholePackages: wholePackages.map((pkg) => pkg.name).sort(),
    files: [...selected.values()]
      .map(({ pkg, files }) => ({ package: pkg.name, files: [...files.keys()].sort() }))
      .sort((a, b) => a.package.localeCompare(b.package)),
  };
}
