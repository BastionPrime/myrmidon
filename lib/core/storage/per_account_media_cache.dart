/// Per-account media cache paths (plan-v3 Т-1.5: «кэш медиа per-account»).
///
/// Upstream MediaCache is one flat `media_cache` directory for all accounts;
/// wellmagram splits it per account so removal is a directory delete and
/// caches never mix.
library;

import 'package:wellmagram/core/accounts/account_key.dart';
import 'per_account_databases.dart';

class PerAccountMediaCache {
  final AccountStoragePaths paths;
  final AccountStorageFs fs;

  const PerAccountMediaCache({required this.paths, required this.fs});

  Future<String> rootFor(AccountKey account) => paths.mediaCacheDir(account);

  Future<bool> exists(AccountKey account) async =>
      fs.exists(await paths.mediaCacheDir(account));

  Future<void> clear(AccountKey account) async {
    final dir = await paths.mediaCacheDir(account);
    if (await fs.exists(dir)) {
      await fs.delete(dir, recursive: true);
    }
  }
}
