library;

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/account_profile.dart';
import 'package:wellmagram/core/accounts/account_registry.dart';
import 'package:wellmagram/core/accounts/accounts_store.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/backends/telegram/td_db_key_store.dart';
import 'package:wellmagram/core/backends/telegram/td_ghost.dart';
import 'package:wellmagram/core/backends/telegram/td_sessions.dart';
import 'package:test/test.dart';

import 'in_memory_secure_storage.dart';
import 'mock_td_client.dart';

const tg1 = AccountKey(network: Network.max, id: 0);
const tgA = AccountKey(network: Network.telegram, id: 1);
const tgB = AccountKey(network: Network.telegram, id: 2);
const maxK = AccountKey(network: Network.max, id: 7);

class InMemoryGhostPrefs implements TdGhostPrefsLike {
  final Map<String, String> data = {};

  @override
  String? getString(String key) => data[key];

  @override
  Future<void> setString(String key, String value) async {
    data[key] = value;
  }
}

AccountProfile profile(Network net, int id) => AccountProfile(
      key: AccountKey(network: net, id: id),
      displayName: 'n$id',
      phone: '',
      updatedAt: id * 1000,
    );

void main() {
  late InMemorySecureStorage secure;
  late CredentialStore credentials;
  late TdDatabaseKeyStore keyStore;
  late List<MockTdClient> created;
  late InMemoryGhostPrefs ghostPrefs;

  setUp(() {
    secure = InMemorySecureStorage();
    credentials = CredentialStore(secure);
    keyStore = TdDatabaseKeyStore(
      credentials: credentials,
      generator: () => List<int>.generate(32, (i) => i),
    );
    created = [];
    ghostPrefs = InMemoryGhostPrefs();
  });

  TdSessionManager manager() => TdSessionManager(
        clientFactory: () {
          final m = MockTdClient()..autoAnswer = true;
          created.add(m);
          return m;
        },
        keyStore: keyStore,
        storageRoot: TdStorageRoot('/data'),
        apiId: 12345,
        apiHash: 'opaque-hash-placeholder',
        ghostPrefs: ghostPrefs,
      );

  group('per-account directories', () {
    test('tg/<id> and tg/<id>/files layout', () {
      final paths = TdSessionPaths(root: '/data');
      expect(paths.databaseDirectory(tgA), '/data/tg/1');
      expect(paths.filesDirectory(tgA), '/data/tg/1/files');
      expect(paths.databaseDirectory(tgB), '/data/tg/2');
    });
  });

  group('start', () {
    test('creates bridge, applies parameters with tg/<id> dirs and key',
        () async {
      final m = manager();
      final session = await m.start(tgA);
      await Future<void>.delayed(Duration.zero);

      expect(m.liveAccounts, [tgA]);
      expect(m.sessionOf(tgA), same(session));
      expect(created, hasLength(1));
      final params = created.first.sentRequests.first;
      expect(params['@type'], 'setTdlibParameters');
      expect(params['database_directory'], '/data/tg/1');
      expect(params['files_directory'], '/data/tg/1/files');
      // The key was generated: 32 bytes as a json byte array.
      final key = params['database_encryption_key'] as List;
      expect(key.length == 32, isTrue,
          reason: 'database_encryption_key is a 32-byte array');
      expect(params['api_id'], 12345);
    });

    test('start is idempotent — one bridge per account', () async {
      final m = manager();
      final first = await m.start(tgA);
      final second = await m.start(tgA);
      expect(second, same(first));
      expect(created, hasLength(1));
    });

    test('MAX keys are rejected (contract of Т-1.7 untouched)', () async {
      final m = manager();
      await expectLater(m.start(maxK), throwsUnsupportedError);
      expect(created, isEmpty);
      expect(m.liveAccounts, isEmpty);
    });

    test('second account gets its own client and directories', () async {
      final m = manager();
      await m.start(tgA);
      await m.start(tgB);
      await Future<void>.delayed(Duration.zero);
      expect(created, hasLength(2));
      expect(m.liveAccounts, unorderedEquals([tgA, tgB]));
      expect(
        created[1].sentRequests.first['database_directory'],
        '/data/tg/2',
      );
    });
  });

  group('ghost profile persistence', () {
    test('default is off; setGhostProfile persists and applies', () async {
      final m = manager();
      expect(await m.ghostProfileOf(tgA), equals(TdGhostSettings.off));

      final session = await m.start(tgA);
      await Future<void>.delayed(Duration.zero);
      // No ghost → no setOption traffic at start.
      final wireAtStart =
          created.first.sentRequests.where((r) => r['@type'] == 'setOption');
      expect(wireAtStart, isEmpty);

      await m.setGhostProfile(
          tgA, const TdGhostSettings(ghostRead: true, ghostTyping: false, ghostOnline: true));
      expect(session.ghost.settings.ghostRead, isTrue);
      expect(session.ghost.settings.ghostTyping, isFalse);
      expect(session.ghost.settings.ghostOnline, isTrue);
      final raw = ghostPrefs.getString('tg_ghost:1');
      expect(raw, isNotNull);

      // New manager (app restart) restores the persisted profile.
      final m2 = manager();
      expect(
        await m2.ghostProfileOf(tgA),
        equals(const TdGhostSettings(
            ghostRead: true, ghostTyping: false, ghostOnline: true)),
      );
    });

    test('restored profile is applied at start BEFORE live (setOption sent)',
        () async {
      final m = manager();
      await m.setGhostProfile(
          tgA, const TdGhostSettings(ghostOnline: true));
      final session = await m.start(tgA);
      await Future<void>.delayed(Duration.zero);
      expect(session.ghost.settings.ghostOnline, isTrue);
      final setOptions = created.first.sentRequests
          .where((r) => r['@type'] == 'setOption');
      expect(setOptions, isNotEmpty,
          reason: 'persisted ghostOnline must be re-applied on start');
    });

    test('corrupt persisted entry falls back to off', () async {
      ghostPrefs.setString('tg_ghost:1', 'not-json{');
      final m = manager();
      expect(await m.ghostProfileOf(tgA), equals(TdGhostSettings.off));
    });
  });

  group('restore at startup', () {
    test('re-creates sessions for registered TG accounts only', () async {
      final registry = AccountRegistry(store: InMemoryAccountsStore());
      await registry.load();
      await registry.add(profile(Network.max, 5));
      await registry.add(profile(Network.telegram, 1));
      await registry.add(profile(Network.telegram, 2));

      final m = manager();
      final restored = await m.restore(registry);
      await Future<void>.delayed(Duration.zero);
      expect(restored, unorderedEquals([tgA, tgB]));
      expect(m.liveAccounts, unorderedEquals([tgA, tgB]));
      expect(created, hasLength(2));
      await registry.dispose();
    });

    test('empty registry restores nothing', () async {
      final registry = AccountRegistry(store: InMemoryAccountsStore());
      await registry.load();
      final m = manager();
      expect(await m.restore(registry), isEmpty);
      expect(created, isEmpty);
      await registry.dispose();
    });
  });

  group('stop / dispose', () {
    test('stop destroys the bridge, keeps account data for restart',
        () async {
      final m = manager();
      await m.start(tgA);
      final client = created.first;
      await m.stop(tgA);
      expect(client.isDestroyed, isTrue);
      expect(m.liveAccounts, isEmpty);

      // Restart works with a fresh client, same persisted key.
      final keyBefore = await keyStore.readKey(tgA);
      await m.start(tgA);
      expect(created, hasLength(2));
      expect(await keyStore.readKey(tgA), keyBefore);
    });

    test('dispose destroys every live session', () async {
      final m = manager();
      await m.start(tgA);
      await m.start(tgB);
      final clients = List<MockTdClient>.of(created);
      await m.dispose();
      expect(clients.every((c) => c.isDestroyed), isTrue);
      expect(m.liveAccounts, isEmpty);
    });
  });
}
