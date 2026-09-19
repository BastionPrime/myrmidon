import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

import 'in_memory_secure_storage.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const tg2 = AccountKey(network: Network.telegram, id: 2);

void main() {
  late InMemorySecureStorage storage;
  late CredentialStore store;

  setUp(() {
    storage = InMemorySecureStorage();
    store = CredentialStore(storage);
  });

  group('namespace', () {
    test('storageKey is cred:<net>:<id>', () {
      expect(CredentialStore.storageKey(max1), 'cred:max:1');
      expect(CredentialStore.storageKey(tg2), 'cred:tg:2');
    });

    test('legacyKey is auth_token_<id>', () {
      expect(CredentialStore.legacyKey(7), 'auth_token_7');
    });
  });

  group('token lifecycle', () {
    test('save and read round-trip', () async {
      await store.saveToken(max1, 'token-one');
      expect(await store.readToken(max1), 'token-one');
    });

    test('readToken returns null for missing and empty values', () async {
      expect(await store.readToken(max1), isNull);
      await storage.write(key: 'cred:max:1', value: '');
      expect(await store.readToken(max1), isNull);
    });

    test('networks are isolated by namespace', () async {
      await store.saveToken(max1, 'max-token');
      await store.saveToken(tg2, 'tg-token');
      expect(await store.readToken(max1), 'max-token');
      expect(await store.readToken(tg2), 'tg-token');
    });

    test('deleteToken removes only the target namespace entry', () async {
      await store.saveToken(max1, 'max-token');
      await store.saveToken(tg2, 'tg-token');
      await store.deleteToken(max1);
      expect(await store.readToken(max1), isNull);
      expect(await store.readToken(tg2), 'tg-token');
    });

    test('hasToken reflects stored value', () async {
      expect(await store.hasToken(max1), isFalse);
      await store.saveToken(max1, 'token-one');
      expect(await store.hasToken(max1), isTrue);
    });

    test('keysWithToken lists and sorts accounts with tokens', () async {
      await store.saveToken(tg2, 'tg-token');
      await store.saveToken(max1, 'max-token');
      await storage.write(key: 'cred:max:3', value: '');
      final keys = await store.keysWithToken();
      expect(keys.map((k) => k.storageId).toList(), ['max:1', 'tg:2']);
    });
  });

  group('deletion', () {
    test('deleteAccountCredentials removes new and legacy MAX entries',
        () async {
      await store.saveToken(max1, 'token-one');
      await storage.write(key: 'auth_token_1', value: 'legacy');
      final removed = await store.deleteAccountCredentials(max1);
      expect(removed, isTrue);
      expect(storage.data, isEmpty);
    });

    test('deleteAccountCredentials ignores legacy entries for Telegram',
        () async {
      await storage.write(key: 'auth_token_2', value: 'legacy');
      final removed = await store.deleteAccountCredentials(tg2);
      expect(removed, isFalse);
      expect(storage.data, contains('auth_token_2'));
    });

    test('deleteAccountCredentials is false when nothing was stored',
        () async {
      expect(await store.deleteAccountCredentials(max1), isFalse);
    });

    test('deleteAccountCredentials does not touch other accounts',
        () async {
      await store.saveToken(max1, 'token-one');
      await storage.write(key: 'auth_token_5', value: 'other');
      await store.deleteAccountCredentials(max1);
      expect(storage.data, containsPair('auth_token_5', 'other'));
    });
  });

  group('legacy migration auth_token_<id> → cred:max:<id>', () {
    test('copies legacy token and removes the legacy key', () async {
      await storage.write(key: 'auth_token_7', value: 'legacy-seven');
      final migrated = await store.migrateLegacyTokens();
      expect(migrated, [7]);
      expect(storage.data, containsPair('cred:max:7', 'legacy-seven'));
      expect(storage.data, isNot(contains('auth_token_7')));
    });

    test('migrates several accounts and returns sorted ids', () async {
      await storage.write(key: 'auth_token_3', value: 'three');
      await storage.write(key: 'auth_token_1', value: 'one');
      final migrated = await store.migrateLegacyTokens();
      expect(migrated, [1, 3]);
      expect(storage.data['cred:max:3'], 'three');
      expect(storage.data['cred:max:1'], 'one');
    });

    test('new value wins: legacy key is dropped, not copied', () async {
      await storage.write(key: 'auth_token_7', value: 'legacy-seven');
      await storage.write(key: 'cred:max:7', value: 'fresh-seven');
      final migrated = await store.migrateLegacyTokens();
      expect(migrated, isEmpty);
      expect(storage.data, containsPair('cred:max:7', 'fresh-seven'));
      expect(storage.data, isNot(contains('auth_token_7')));
    });

    test('accountIds filter restricts migration scope', () async {
      await storage.write(key: 'auth_token_7', value: 'seven');
      await storage.write(key: 'auth_token_8', value: 'eight');
      final migrated = await store.migrateLegacyTokens(accountIds: {7});
      expect(migrated, [7]);
      expect(storage.data, containsPair('cred:max:7', 'seven'));
      expect(storage.data, containsPair('auth_token_8', 'eight'));
    });

    test('malformed legacy keys are ignored', () async {
      await storage.write(key: 'auth_token_notanumber', value: 'junk');
      await storage.write(key: 'auth_token_-1', value: 'negative');
      await storage.write(key: 'auth_token_', value: 'empty');
      final migrated = await store.migrateLegacyTokens();
      expect(migrated, isEmpty);
      expect(storage.data, isNot(contains('cred:max:-1')));
    });

    test('migration is idempotent', () async {
      await storage.write(key: 'auth_token_7', value: 'seven');
      await store.migrateLegacyTokens();
      final second = await store.migrateLegacyTokens();
      expect(second, isEmpty);
      expect(storage.data, containsPair('cred:max:7', 'seven'));
    });

    test('non-legacy keys are untouched', () async {
      await storage.write(key: 'auth_token_7', value: 'seven');
      await storage.write(key: 'cred:tg:2', value: 'tg-token');
      await storage.write(key: 'unrelated', value: 'other');
      await store.migrateLegacyTokens();
      expect(storage.data, containsPair('cred:tg:2', 'tg-token'));
      expect(storage.data, containsPair('unrelated', 'other'));
    });

    test('empty storage migrates nothing', () async {
      expect(await store.migrateLegacyTokens(), isEmpty);
    });
  });

  group('plugin seam', () {
    test('default construction without useStorage fails loudly', () {
      expect(() => CredentialStore(), throwsStateError);
    });
  });
}
