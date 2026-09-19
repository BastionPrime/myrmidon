/// Per-account database storage (plan-v3 Т-1.5).
///
/// Upstream Komet keeps ALL accounts in one `komet.db` (single static
/// instance, version 23). For wellmagram each account gets its own database
/// file `wellmagram_<net>_<id>.db` plus its own media-cache directory, so
/// account removal is a file-level operation with no cross-account residue
/// (plan 4.7 п.8: токен, БД, кэш медиа, спуф-профиль — всё удаляется).
///
/// The sqflite/path seams are injectable: unit tests run on in-memory maps,
/// production wires `sqflite` + `path_provider` in the build image.
library;

import 'package:wellmagram/core/accounts/account_key.dart';

/// Narrow seam over `sqflite` (raw SQL surface actually needed).
abstract class DatabaseLike {
  Future<void> execute(String sql, [List<Object?>? args]);
  Future<int> delete(String table, String where, List<Object?> whereArgs);
  Future<List<Map<String, Object?>>> query(
    String table, {
    String? where,
    List<Object?>? whereArgs,
    String? orderBy,
    int? limit,
  });
  Future<void> close();
}

/// Factory opening/creating a database file (sqflite `openDatabase` seam).
typedef DatabaseOpener = Future<DatabaseLike> Function(String path);

/// Path provider seam: base directory for account databases and media cache.
abstract class AccountStoragePaths {
  Future<String> databaseDir();
  Future<String> mediaCacheDir(AccountKey account);
}

/// Filesystem seam for media cache cleanup on account removal.
abstract class AccountStorageFs {
  Future<bool> exists(String path);
  Future<void> delete(String path, {bool recursive});
}

class PerAccountDatabases {
  final DatabaseOpener opener;
  final AccountStoragePaths paths;
  final AccountStorageFs fs;

  final Map<AccountKey, DatabaseLike> _open = {};

  PerAccountDatabases({
    required this.opener,
    required this.paths,
    required this.fs,
  });

  /// `wellmagram_<net>_<id>.db` — network-qualified, collision-free for
  /// MAX and Telegram ids living in one app.
  static String fileName(AccountKey account) =>
      'wellmagram_${account.network.storageName}_${account.id}.db';

  /// Directory holding one account's media cache:
  /// `<mediaCacheRoot>/<net>_<id>`.
  static String mediaCacheFolderName(AccountKey account) =>
      '${account.network.storageName}_${account.id}';

  Future<DatabaseLike> forAccount(AccountKey account) async {
    final existing = _open[account];
    if (existing != null) return existing;
    final dir = await paths.databaseDir();
    final db = await opener('$dir/${fileName(account)}');
    await db.execute('PRAGMA foreign_keys = ON');
    _open[account] = db;
    return db;
  }

  Future<void> close(AccountKey account) async {
    final db = _open.remove(account);
    await db?.close();
  }

  /// Removes the account's database and media cache entirely.
  /// Returns what was actually removed (never throws on missing files).
  Future<AccountRemovalReport> removeAccount(AccountKey account) async {
    await close(account);
    final dir = await paths.databaseDir();
    final mediaDir = await paths.mediaCacheDir(account);
    final report = AccountRemovalReport(account: account);
    final dbPath = '$dir/${fileName(account)}';
    if (await fs.exists(dbPath)) {
      await fs.delete(dbPath);
      report.databaseRemoved = true;
    }
    if (await fs.exists(mediaDir)) {
      await fs.delete(mediaDir, recursive: true);
      report.mediaCacheRemoved = true;
    }
    return report;
  }

  Future<bool> isAccountPresent(AccountKey account) async {
    final dir = await paths.databaseDir();
    return fs.exists('$dir/${fileName(account)}');
  }
}

class AccountRemovalReport {
  final AccountKey account;
  bool databaseRemoved = false;
  bool mediaCacheRemoved = false;

  AccountRemovalReport({required this.account});

  bool get removedAnything => databaseRemoved || mediaCacheRemoved;
}
