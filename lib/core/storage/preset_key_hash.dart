// Deterministic per-key preset selection (filler task: stable pick per
// account key, distinct picks across keys). Pure string -> int hashing:
// FNV-1a 32-bit, no Dart:crypto dependency, stable across platforms and
// Dart versions (no String.hashCode — that is randomized per run).
int fnv1a32(String input) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < input.length; i++) {
    final codeUnit = input.codeUnitAt(i);
    // Hash UTF-8 bytes, not UTF-16 code units, so the digest is the same
    // for any string content (ASCII keys in practice, but be correct).
    if (codeUnit < 0x80) {
      hash ^= codeUnit;
      hash = (hash * 0x01000193) & 0xffffffff;
    } else {
      // Encode the code unit as UTF-8 bytes.
      final bytes = _utf8Bytes(codeUnit);
      for (final b in bytes) {
        hash ^= b;
        hash = (hash * 0x01000193) & 0xffffffff;
      }
    }
  }
  return hash;
}

List<int> _utf8Bytes(int codeUnit) {
  if (codeUnit < 0x80) return [codeUnit];
  if (codeUnit < 0x800) {
    return [0xc0 | (codeUnit >> 6), 0x80 | (codeUnit & 0x3f)];
  }
  return [
    0xe0 | (codeUnit >> 12),
    0x80 | ((codeUnit >> 6) & 0x3f),
    0x80 | (codeUnit & 0x3f),
  ];
}

/// Maps an account key (already the storage key string:
/// `spoof_profile_<net>_<id>`-style) onto a preset index in [0, count).
/// The same key always yields the same index; different keys are spread
/// across the table by the hash.
int presetIndexForAccountKey(String accountKey, int count) {
  if (count <= 0) {
    throw ArgumentError.value(count, 'count', 'must be positive');
  }
  return fnv1a32(accountKey) % count;
}
