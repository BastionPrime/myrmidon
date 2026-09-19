import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/storage/legacy_db_migrator.dart';
import 'package:wellmagram/core/storage/per_account_databases.dart';
import 'package:wellmagram/core/storage/per_account_media_cache.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const max2 = AccountKey(network: Network.max, id: 2);
const tg3 = AccountKey(network: Network.telegram, id: 3);

class FakeDb implements DatabaseLike {
  bool closed = false;
  int pragmaCount = 0;
  final List<String> executed = [];

  @override
  Future<void> execute(String sql, [List<Object?>? args]) async {
    executed.add(sql);
    if (sql.startsWith('PRAGMA')) pragmaCount++;
  }

  @override
  Future<int> delete(String table, String where, List<Object?> whereArgs) async => 0;

  @override
  Future<List<Map<String, Object?>>> query(
    String table, {
    String? where,
    List<Object?>? whereArgs,
    String? orderBy,
    int? limit,
  }) async =>
      const [];

  @override
  Future<void> close() async {
    closed = true;
  }
}

class FakePaths implements AccountStoragePaths {
  String dbDir = '/data/db';
  String mediaRoot = '/data/media_cache';
  final List<String> askedMediaDirs = [];

  @override
  Future<String> databaseDir() async => dbDir;

  @override
  Future<String> mediaCacheDir(AccountKey account) async {
    final dir = '$mediaRoot/${PerAccountDatabases.mediaCacheFolderName(account)}';
    askedMediaDirs.add(dir);
    return dir;
  }
}

class FakeFs implements AccountStorageFs {
  final Set<String> existing = {};
  final List<String> deleted = [];
  final List<(String, bool)> deletedRecursive = [];

  @override
  Future<bool> exists(String path) async => existing.contains(path);

  @override
  Future<void> delete(String path, {bool recursive = false}) async {
    deleted.add(path);
    deletedRecursive.add((path, recursive));
    existing.remove(path);
  }
}

PerAccountDatabases makeDatabases() {
  final paths = FakePaths();
  final fs = FakeFs();
  return PerAccountDatabases(
    opener: (path) async => FakeDb(),
    paths: paths,
    fs: fs,
  );
}

void main() {
  group('naming', () {
    test('database file name is network-qualified', () {
      expect(PerAccountDatabases.fileName(max1), 'wellmagram_max_1.db');
      expect(PerAccountDatabases.fileName(tg3), 'wellmagram_tg_3.db');
    });

    test('media cache folder per account', () {
      expect(PerAccountDatabases.mediaCacheFolderName(max2), 'max_2');
      expect(PerAccountDatabases.mediaCacheFolderName(tg3), 'tg_3');
    });
  });

  group('forAccount', () {
    test('opens one database per account with foreign_keys ON', () async {
      final dbs = makeDatabases();
      final db = await dbs.forAccount(max1);
      expect((db as FakeDb).executed, contains('PRAGMA foreign_keys = ON'));
      expect(db.pragmaCount, 1);
    });

    test('reuses the same handle for the same account', () async {
      final dbs = makeDatabases();
      final a = await dbs.forAccount(max1);
      final b = await dbs.forAccount(max1);
      expect(identical(a, b), isTrue);
      expect((a as FakeDb).pragmaCount, 1);
    });

    test('separate handles per account', () async {
      final dbs = makeDatabases();
      final a = await dbs.forAccount(max1);
      final b = await dbs.forAccount(max2);
      expect(identical(a, b), isFalse);
    });

    test('close closes the handle and drops the cache', () async {
      final dbs = makeDatabases();
      final db = await dbs.forAccount(max1);
      await dbs.close(max1);
      expect((db as FakeDb).closed, isTrue);
      final reopened = await dbs.forAccount(max1);
      expect(identical(reopened, db), isFalse);
    });
  });

  group('removeAccount', () {
    test('removes database file and media cache recursively', () async {
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/db/wellmagram_max_1.db');
      fs.existing.add('/data/media_cache/max_1');
      final dbs = PerAccountDatabases(
        opener: (path) async => FakeDb(),
        paths: paths,
        fs: fs,
      );

      final report = await dbs.removeAccount(max1);

      expect(report.databaseRemoved, isTrue);
      expect(report.mediaCacheRemoved, isTrue);
      expect(report.removedAnything, isTrue);
      expect(fs.deleted, containsAll([
        '/data/db/wellmagram_max_1.db',
        '/data/media_cache/max_1',
      ]));
      expect(fs.deletedRecursive, contains(('/data/media_cache/max_1', true)));
      expect(
        fs.deletedRecursive,
        isNot(contains(('/data/db/wellmagram_max_1.db', true))),
      );
    });

    test('missing artifacts report false and do not throw', () async {
      final dbs = makeDatabases();
      final report = await dbs.removeAccount(max2);
      expect(report.removedAnything, isFalse);
    });

    test('other accounts keep their files', () async {
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/db/wellmagram_max_1.db');
      fs.existing.add('/data/db/wellmagram_max_2.db');
      fs.existing.add('/data/media_cache/max_1');
      fs.existing.add('/data/media_cache/max_2');
      final dbs = PerAccountDatabases(
        opener: (path) async => FakeDb(),
        paths: paths,
        fs: fs,
      );

      await dbs.removeAccount(max1);

      expect(fs.existing, containsAll([
        '/data/db/wellmagram_max_2.db',
        '/data/media_cache/max_2',
      ]));
      expect(fs.existing, isNot(contains('/data/db/wellmagram_max_1.db')));
    });

    test('closes the open handle before deleting', () async {
      final opened = <FakeDb>[];
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/db/wellmagram_max_1.db');
      final dbs = PerAccountDatabases(
        opener: (path) async {
          final db = FakeDb();
          opened.add(db);
          return db;
        },
        paths: paths,
        fs: fs,
      );
      await dbs.forAccount(max1);
      await dbs.removeAccount(max1);
      expect(opened.single.closed, isTrue);
    });

    test('isAccountPresent reflects the file', () async {
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/db/wellmagram_max_1.db');
      final dbs = PerAccountDatabases(
        opener: (path) async => FakeDb(),
        paths: paths,
        fs: fs,
      );
      expect(await dbs.isAccountPresent(max1), isTrue);
      expect(await dbs.isAccountPresent(max2), isFalse);
    });
  });

  group('legacy migration', () {
    test('copies account rows into its own database', () async {
      final dbs = makeDatabases();
      final inserted = <(AccountKey, String, Map<String, Object?>)>[];
      final legacy = _FakeLegacySource(
        profiles: [1, 2],
        rows: {
          'messages': {
            1: [
              {'id': 10, 'account_id': 1, 'text': 'a'},
              {'id': 11, 'account_id': 1, 'text': 'b'},
            ],
            2: [
              {'id': 20, 'account_id': 2, 'text': 'c'},
            ],
          },
        },
        onInsert: (account, table, row) async {
          inserted.add((account, table, row));
        },
      );
      final migrator = LegacyDbMigrator(databases: dbs, legacy: legacy);

      final counts = await migrator.migrateAccount(max1);

      expect(counts['messages'], 2);
      expect(inserted, hasLength(2));
      expect(inserted.first.$1, max1);
      expect(inserted.first.$2, 'messages');
      expect(inserted.first.$3, {'id': 10, 'account_id': 1, 'text': 'a'});
    });

    test('legacyAccounts lists MAX keys sorted', () async {
      final dbs = makeDatabases();
      final legacy = _FakeLegacySource(profiles: [9, 2], rows: const {});
      final migrator = LegacyDbMigrator(databases: dbs, legacy: legacy);
      final accounts = await migrator.legacyAccounts();
      expect(accounts.map((a) => a.storageId).toList(), ['max:2', 'max:9']);
    });

    test('telegram accounts are rejected explicitly', () async {
      final migrator = LegacyDbMigrator(
        databases: makeDatabases(),
        legacy: _FakeLegacySource(profiles: [1], rows: const {}),
      );
      expect(migrator.migrateAccount(tg3), throwsUnsupportedError);
    });
  });

  group('media cache', () {
    test('clear removes only the account directory', () async {
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/media_cache/max_1');
      fs.existing.add('/data/media_cache/max_2');
      final cache = PerAccountMediaCache(paths: paths, fs: fs);

      await cache.clear(max1);

      expect(fs.existing, contains('/data/media_cache/max_2'));
      expect(fs.existing, isNot(contains('/data/media_cache/max_1')));
    });

    test('clear on missing directory is a no-op', () async {
      final cache = PerAccountMediaCache(paths: FakePaths(), fs: FakeFs());
      await cache.clear(max1);
    });

    test('exists mirrors the filesystem', () async {
      final paths = FakePaths();
      final fs = FakeFs();
      fs.existing.add('/data/media_cache/max_1');
      final cache = PerAccountMediaCache(paths: paths, fs: fs);
      expect(await cache.exists(max1), isTrue);
      expect(await cache.exists(max2), isFalse);
    });
  });
}

class _FakeLegacySource implements LegacyDbSource {
  final List<int> profiles;
  final Map<String, Map<int, List<Map<String, Object?>>>> rows;
  final Future<void> Function(
    AccountKey account,
    String table,
    Map<String, Object?> row,
  )? onInsert;

  _FakeLegacySource({
    required this.profiles,
    required this.rows,
    this.onInsert,
  });

  @override
  Future<List<int>> profileAccountIds() async => List.of(profiles);

  @override
  Future<List<Map<String, Object?>>> rowsFor(String table, int accountId) async =>
      rows[table]?[accountId] ?? const [];

  @override
  Future<void> insertInto(
    DatabaseLike target,
    String table,
    Map<String, Object?> row,
  ) async {
    await onInsert?.call(
      AccountKey(network: Network.max, id: row['account_id'] as int),
      table,
      row,
    );
  }
}
