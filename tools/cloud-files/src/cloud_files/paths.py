"""Bot-supplied paths: normalised, confined to a root, never an id."""

from __future__ import annotations

import re
import unicodedata

BAD_CHARS = re.compile(r'[\x00-\x1f"*:<>?|\\]')


class PathError(ValueError):
    pass


def split_path(p: str | None) -> list[str]:
    """Relative path inside a root -> components (NFC). '..', absolute prefixes tricks and
    characters OneDrive does not allow are refused; the root itself is []."""
    p = unicodedata.normalize("NFC", (p or "").replace("\\", "/"))
    parts: list[str] = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise PathError("'..' is not allowed in a path")
        if BAD_CHARS.search(seg) or len(seg) > 255:
            raise PathError(f"bad character in path segment {seg[:40]!r}")
        parts.append(seg)
    if len(parts) > 32:
        raise PathError("path is too deep")
    return parts


def norm_name(s: str) -> str:
    """Name comparison key: the files come from macOS (NFD) and from Windows (NFC)."""
    return unicodedata.normalize("NFC", s).casefold()
