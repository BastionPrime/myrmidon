#!/usr/bin/env python3
"""Machine check of TDLib json field names used by wellmagram against the
official td_api.tl schema.

Extracts constructor definitions from td_api.tl, then walks the mock script,
the request bodies the production code builds, AND the test fixtures
(fixtures are wire forms too — review a35a3932: the restricted-gate
fixture carried the same fabricated names as the production bug), asserting
every snake_case key exists in the corresponding constructor of the schema.

The Dart scanner is a real brace-depth parser over map literals: each
{...} block is attributed to its own '@type' value; nested maps (an update
wrapping a message wrapping a content object) keep their own constructor.
Comments are stripped before tokenizing (an apostrophe in a doc comment
desynchronized the old quote regex and silently dropped whole files —
review 3b9d24c6); empty '' literals and index accesses json['key'] are
consumed explicitly so the quote balance never breaks.

Index accesses json['key'] in production code are no longer discarded
(review a35a3932: the strip silently dropped them and the fabricated
can_invite_users_by_link slipped through). They are captured before the
strip and checked against the UNION of all constructor fields: a read of
a name that exists in no constructor is a fabricated field name.

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

# Intentional negative fixtures (regression tests for fabricated names —
# review a35a3932): these keys are DELIBERATELY wrong wire names used by
# the test asserting they do NOT open the restricted gate. Tolerated ONLY
# in files that carry the marker comment below — so the pre-fix tree
# (same names, no marker) still fails the check and the bug reproduces.
NEGATIVE_FIXTURE_MARKER = '// td_schema_check: NEGATIVE_FIXTURE'
NEGATIVE_FIXTURE_KEYS = {
    'td_groups_test.dart': {
        'chatPermissions': {'can_send_messages', 'can_invite_users_by_link'},
    },
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


def _strip_non_payloads(text: str) -> tuple[str, list[str]]:
    """Remove everything that is NOT a map-key/constructor payload.

    Order matters: comments first (apostrophes in doc comments), then
    comparison operands == 'name' (they are reads / constructor names, not
    wire payloads), replaced with a balanced, quote-free stub so the token
    stream stays in sync.

    Index accesses json['key'] are NOT dropped anymore (review a35a3932):
    they are extracted here and returned, then checked against the UNION
    of all constructor fields (a read of a name that exists nowhere is a
    fabricated field). The stub replacement keeps the quote balance intact.
    """
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    text = re.sub(r'//[^\n]*', '', text)
    index_keys = re.findall(r"\[\s*'([a-zA-Z_@][a-zA-Z0-9_]*)'\s*\]", text)
    text = re.sub(r"\[\s*'([a-zA-Z_@][a-zA-Z0-9_]*)'\s*\]", '[]', text)
    text = re.sub(r"==\s*'([^']*)'", ' == ', text)
    text = re.sub(r"!=\s*'([^']*)'", ' != ', text)
    return text, index_keys


def dart_string_keys(path: Path) -> list[tuple[str, str]]:
    """All map-key literals of a Dart file with their @type constructor.

    A token stream over strings AND punctuation (braces, brackets, parens,
    commas, colons): '{' pushes a map frame, '}' pops it. A string literal
    is a MAP KEY iff the next token is ':' and the previous token is '{'
    or ',' — string VALUES ('ok', 'x', 'fresh', named-argument values like
    text: 'fresh') never match that shape, so they can no longer be
    misread as wire fields (the old parser did, producing false hits like
    formattedText.ok / messages.newer in test fixtures — review a35a3932).

    Inside a frame, the literal right after the '@type' key is the
    constructor name of THAT frame (nested frames carry their own); if the
    '@type' value is a runtime variable, no static constructor is recorded
    and the frame's keys are conservatively skipped.
    """
    text, _index_keys = _strip_non_payloads(path.read_text())
    # Empty literals must consume their quotes or the balance breaks.
    token_re = re.compile(r"'([^']*)'|([{}()\[\],:])")
    tokens = [(m.group(1), m.group(2)) for m in token_re.finditer(text)]
    # Each token is (literal, punct); exactly one of the two is not None.

    def is_key(i: int) -> bool:
        """tokens[i] is a string; is it a map key? (followed by ':',
        preceded by '{' or ',')."""
        if i + 1 >= len(tokens) or tokens[i + 1][1] != ':':
            return False
        if i == 0:
            return False
        return tokens[i - 1][1] in ('{', ',')

    pairs: list[tuple[str, str]] = []
    stack: list[dict] = []

    i = 0
    n = len(tokens)
    while i < n:
        literal, punct = tokens[i]
        if literal is not None:
            if literal == '':
                i += 1
                continue
            if stack and is_key(i):
                frame = stack[-1]
                if literal == '@type' and not frame['type_seen']:
                    # The constructor of this frame is the next string
                    # token that is itself NOT a key, before the frame
                    # closes; a key right after '@type' means the value
                    # was a runtime variable — no static constructor.
                    j = i + 1
                    depth = 0
                    constructor = None
                    while j < n:
                        lit2, punct2 = tokens[j]
                        if lit2 is not None:
                            if is_key(j):
                                break
                            if lit2 != '':
                                constructor = lit2
                                break
                        elif punct2 == '}':
                            if depth == 0:
                                break
                            depth -= 1
                        elif punct2 == '{':
                            depth += 1
                        j += 1
                    frame['constructor'] = constructor
                    frame['type_seen'] = True
                    i += 1
                    continue
                if _looks_like_field(literal):
                    constructor = frame['constructor']
                    if constructor:
                        pairs.append((constructor, literal))
            i += 1
            continue
        if punct == '{':
            stack.append({'constructor': None, 'type_seen': False})
        elif punct == '}':
            if stack:
                stack.pop()
        i += 1
    return pairs


def _looks_like_field(literal: str) -> bool:
    """A wire-field-looking key: snake_case / lowerCamel known names."""
    if literal.startswith('@'):
        return False
    return bool(re.fullmatch(r'[a-z][a-z0-9_]*', literal))


def prod_index_keys(path: Path) -> list[str]:
    """Field names read from TDLib json in production code.

    Every ``x['key']`` index access with a snake_case key is a read of a
    wire field (review a35a392: the old strip discarded these, so the
    fabricated ``perm['can_invite_users_by_link']`` was invisible to the
    shield). Returned here and checked against the UNION of all
    constructor fields: a name that exists in no constructor is a
    fabricated field name. Union instead of exact constructor because the
    accessed receiver's constructor is not statically known.
    (review a35a3932)
    """
    _text, index_keys = _strip_non_payloads(path.read_text())
    return [key for key in index_keys if _looks_like_field(key)]


def main() -> int:
    schema_path = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/td_api.tl')
    schema = parse_schema(schema_path)
    all_fields: set[str] = set()
    for fields in schema.values():
        all_fields.update(fields)

    # Glob instead of a hardcoded list (review fe79e1af): every present and
    # FUTURE file of the telegram module is covered automatically — the
    # "forgot to add the new file to coverage" defect class disappears.
    # telegram.dart (the barrel) contains no wire literals; the mock and
    # the td_*_test.dart fixtures below are covered by their own globs.
    prod_files = sorted(
        (REPO / 'lib' / 'core' / 'backends' / 'telegram').glob('td_*.dart')
    )
    fixture_files = [
        REPO / 'test' / 'mock_td_client.dart',
        *sorted((REPO / 'test').glob('td_*_test.dart')),
    ]
    files = fixture_files + prod_files

    failures: list[str] = []
    checked = 0
    for file in files:
        raw_text = file.read_text()
        has_marker = NEGATIVE_FIXTURE_MARKER in raw_text
        negative_keys = NEGATIVE_FIXTURE_KEYS.get(file.name, {}) if has_marker else {}
        for constructor, key in dart_string_keys(file):
            if constructor in LEGACY_CONSTRUCTORS:
                continue
            if key in WELL_KNOWN_NON_WIRE_KEYS.get(constructor, set()):
                continue
            if key in negative_keys.get(constructor, set()):
                continue
            fields = schema.get(constructor)
            if fields is None:
                failures.append(f'{file.name}: unknown constructor {constructor}')
                continue
            if key not in fields:
                failures.append(f'{file.name}: {constructor}.{key} not in schema')
                continue
            checked += 1
        if file in prod_files:
            for key in prod_index_keys(file):
                if key in all_fields:
                    checked += 1
                else:
                    failures.append(f'{file.name}: index read {key} exists in no constructor')

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
