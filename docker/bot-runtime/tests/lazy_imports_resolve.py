"""myrmidon(G1): every `from X import name` in the patched modules resolves.

The import smoke in the Dockerfile imports each patched module, which runs only
its top-level imports. Imports placed inside functions (lazy imports, as patch 09
does in _run_agent_sync) execute only when a run starts, so a missing name there
broke every run of the 1.6.0 image while the build stayed green. This check parses
the patched modules, collects every `from <module> import <names>` at any depth,
imports <module> and asserts each name exists.

Usage: lazy_imports_resolve.py <hermes-src> <module> [<module> ...]
"""

import ast
import importlib
import sys
from pathlib import Path


def module_file(src: Path, dotted: str) -> Path:
    base = src.joinpath(*dotted.split("."))
    return base.with_suffix(".py") if base.with_suffix(".py").exists() else base / "__init__.py"


def main() -> int:
    src = Path(sys.argv[1])
    sys.path.insert(0, str(src))
    failures = []
    checked = 0
    for dotted in sys.argv[2:]:
        tree = ast.parse(module_file(src, dotted).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level or not node.module:
                continue
            try:
                target = importlib.import_module(node.module)
            except ImportError:
                continue  # optional third-party dependency; the import smoke owns module-level failures
            for alias in node.names:
                if alias.name == "*":
                    continue
                checked += 1
                if not hasattr(target, alias.name):
                    try:
                        importlib.import_module(f"{node.module}.{alias.name}")
                    except ImportError:
                        failures.append(f"{dotted}:{node.lineno}: from {node.module} import {alias.name}")
    if failures:
        print("unresolved imports in patched modules:\n  " + "\n  ".join(failures))
        return 1
    print(f"lazy imports resolve: {checked} names in {len(sys.argv) - 2} modules")
    return 0


if __name__ == "__main__":
    sys.exit(main())
