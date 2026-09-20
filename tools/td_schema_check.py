#!/usr/bin/env python3
"""Machine check of TDLib json field names used by wellmagram against the
official td_api.tl schema (review feedback (г), OPE-2494 fix branch).

Extracts constructor definitions from td_api.tl, then walks the mock script
and the request bodies the production code builds, asserting every
snake_case key exists in the corresponding constructor of the schema.

Usage: python3 tools/td_schema_check.py [path-to-td_api.tl]
Exit code 0 = all names verified; nonzero = mismatches found.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

ALLOWED_EXTRA_KEYS = {'@type', '@extra', '@client_id'}
LEGACY_CONSTRUCTORS = {
    # Deliberately supported for older TDLib versions (ADR-0001):
    'setDatabaseEncryptionKey',
    'authorizationStateWaitEncryptionKey',
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


def dart_string_keys(path: Path) -> list[tuple[str, str]]:
    """All 'snake_case' string literals and their enclosing @type context.

    Returns (constructor, key) pairs: a key literal counts as a field of the
    constructor named by the nearest preceding '@type' literal in the same
    map literal.
    """
    text = path.read_text()
    pairs: list[tuple[str, str]] = []
    stack: list[str] = []
    # Skip literals used in comparisons (== 'name' / != 'name'): they name
    # constructors, not fields. Drop them from the token stream up front.
    text = re.sub(r"==\s*'([^']+)'", '', text)
    text = re.sub(r"!=\s*'([^']+)'", '', text)
    token_re = re.compile(r"'([^']+)'|(\{|\})")
    for match in token_re.finditer(text):
        literal, brace = match.group(1), match.group(2)
        if literal is not None:
            if literal == '@type':
                # Next literal is the constructor name.
                nxt = token_re.search(text, match.end())
                if nxt and nxt.group(1) is not None:
                    stack.append(nxt.group(1))
                continue
            if literal.startswith('@') or not literal.startswith((
                'update', 'chat', 'message', 'authorization', 'user',
                'allow_', 'is_', 'use_', 'has_', 'database_', 'api_', 'api',
                'phone_number', 'system_', 'device_', 'application_', 'files_',
                'new_verbosity', 'from_message', 'only_local', 'last_read',
                'unread_', 'code', 'password', 'title', 'text', 'chat_id',
                'user_id', 'message_id', 'message_ids', 'sender_id', 'date',
                'order', 'position', 'last_message', 'content', 'photo',
                'positions', 'new_content', 'settings', 'limit', 'offset',
                'authorization_state', 'last_read_inbox_message_id',
                'last_read_outbox_message_id', 'unread_count',
                'unread_mention_count', 'last_message_id', 'state',
                'password_hint', 'has_recovery_email_address', 'chat_list',
                'is_pinned', 'is_channel', 'is_outgoing', 'is_downloading_completed',
                'first_name', 'last_name', 'type', 'order_extra',
            )):
                continue
            constructor = stack[-1] if stack else ''
            if constructor:
                pairs.append((constructor, literal))
        elif brace == '{':
            continue
        elif brace == '}':
            if stack:
                stack.pop()
    return pairs


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
            fields = schema.get(constructor)
            if fields is None:
                # Unknown constructor: key check impossible, reported.
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
