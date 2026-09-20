#!/usr/bin/env python3
"""Machine check of TDLib json field names used by wellmagram against the
official td_api.tl schema (review feedback (г), OPE-2494 fix branch).

Extracts constructor definitions from td_api.tl, then walks the mock script
and the request bodies the production code builds, asserting every
snake_case key exists in the corresponding constructor of the schema.

The Dart scanner is a real brace-depth parser over map literals: each
{...} block is attributed to its own '@type' value; nested maps (an update
wrapping a message wrapping a content object) keep their own constructor.
Comments are stripped before tokenizing (an apostrophe in a doc comment
desynchronized the old quote regex and silently dropped whole files —
review 3b9d24c6); empty '' literals and index accesses json['key'] are
consumed explicitly so the quote balance never breaks.

Usage: python3 tools/td_schema_check.py [path-to-td_api.tl]
Exit code 0 = all names verified; nonzero = mismatches found.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

LEGACY_CONSTRUCTORS = {
    # Deliberately supported for older TDLib versions (ADR-0001):
    'setDatabaseEncryptionKey',
    'authorizationStateWaitEncryptionKey',
}

# Field names that are NOT TDLib wire fields but appear as map keys in the
# scanned files (unified-model side or test bookkeeping).
WELL_KNOWN_NON_WIRE_KEYS = {
    'error': {'code', 'message'},
}


def parse_schema(path: Path) -> dict[str, set[str]]:
    """@type constructor -> set of field names from the tl schema."""
    constructors: dict[str, set[str]] = {}
    # A constructor line: name field1:type field2:type ... = ResultType;
    pattern = re.compile(r'^([a-zA-Z][a-zA-Z0-9_]*)\s+([^=;]+?)\s*=\s*[a-zA-Z]')
    for raw in path.read_text().splitlines():
        line = raw.split('//')[0].strip()
        if not line or line.startswith('---') or line.startswith('//@'):
            continue
        match = pattern.match(line)
        if not match:
            continue
        name, fields = match.group(1), match.group(2)
        field_names = set()
        for token in fields.split():
            if ':' in token:
                field_names.add(token.split(':', 1)[0].strip())
        constructors.setdefault(name, set()).update(field_names)
    return constructors


def _strip_non_payloads(text: str) -> str:
    """Remove everything that is NOT a map-key/constructor payload.

    Order matters: comments first (apostrophes in doc comments), then
    index accesses json['key'] and comparison operands == 'name' (they are
    reads / constructor names, not wire payloads), each replaced with a
    balanced, quote-free stub so the token stream stays in sync.
    """
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    text = re.sub(r'//[^\n]*', '', text)
    text = re.sub(r"\[\s*'([^']*)'\s*\]", '[]', text)
    text = re.sub(r"==\s*'([^']*)'", ' == ', text)
    text = re.sub(r"!=\s*'([^']*)'", ' != ', text)
    return text


def dart_string_keys(path: Path) -> list[tuple[str, str]]:
    """All map-key literals of a Dart file with their @type constructor.

    A real depth-first walk over the token stream: '{' pushes a map frame,
    '}' pops it; inside a frame, the literal right after the '@type' key is
    the constructor name of THAT frame (nested frames carry their own).
    Returns (constructor, key) pairs for every other snake_case-looking key.
    """
    text = _strip_non_payloads(path.read_text())
    # Empty literals must consume their quotes or the balance breaks.
    token_re = re.compile(r"'([^']*)'|(\{|\})")
    tokens = [(m.start(), m.group(1), m.group(2)) for m in token_re.finditer(text)]

    pairs: list[tuple[str, str]] = []
    stack: list[dict] = []

    i = 0
    n = len(tokens)
    while i < n:
        pos, literal, brace = tokens[i]
        if literal is not None:
            if literal == '':
                i += 1
                continue
            if stack:
                frame = stack[-1]
                if literal == '@type' and not frame['type_seen']:
                    # The next string token is the constructor of this map.
                    j = i + 1
                    while j < n and tokens[j][1] is None:
                        j += 1
                    if j < n and tokens[j][1]:
                        frame['constructor'] = tokens[j][1]
                        frame['type_seen'] = True
                    i = j + 1 if j < n else i + 1
                    continue
                if _looks_like_field(literal):
                    constructor = frame['constructor']
                    if constructor:
                        pairs.append((constructor, literal))
            i += 1
            continue
        if brace == '{':
            stack.append({'constructor': None, 'type_seen': False})
        elif brace == '}':
            if stack:
                stack.pop()
        i += 1
    return pairs


def _looks_like_field(literal: str) -> bool:
    """A wire-field-looking key: snake_case / lowerCamel known names."""
    if literal.startswith('@'):
        return False
    return bool(re.fullmatch(r'[a-z][a-z0-9_]*', literal))


def main() -> int:
    schema_path = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/td_api.tl')
    schema = parse_schema(schema_path)

    files = [
        REPO / 'test' / 'mock_td_client.dart',
        REPO / 'lib' / 'core' / 'backends' / 'telegram' / 'td_auth_flow.dart',
        REPO / 'lib' / 'core' / 'backends' / 'telegram' / 'td_client_seam.dart',
        REPO / 'lib' / 'core' / 'backends' / 'telegram' / 'td_chat_store.dart',
    ]
    failures: list[str] = []
    checked = 0
    for file in files:
        for constructor, key in dart_string_keys(file):
            if constructor in LEGACY_CONSTRUCTORS:
                continue
            if key in WELL_KNOWN_NON_WIRE_KEYS.get(constructor, set()):
                continue
            fields = schema.get(constructor)
            if fields is None:
                failures.append(f'{file.name}: unknown constructor {constructor}')
                continue
            if key not in fields:
                failures.append(f'{file.name}: {constructor}.{key} not in schema')
                continue
            checked += 1

    print(f'td_schema_check: {checked} field names verified against '
          f'{schema_path.name} ({len(schema)} constructors)')
    if failures:
        print('MISMATCHES:')
        for failure in failures:
            print(f'  - {failure}')
        return 1
    print('OK: no mismatches')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
