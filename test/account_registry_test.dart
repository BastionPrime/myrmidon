

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/account_profile.dart';
import 'package:wellmagram/core/accounts/account_registry.dart';
import 'package:wellmagram/core/accounts/account_registry_event.dart';
import 'package:wellmagram/core/accounts/accounts_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

AccountProfile profile(Network net, int id, {String name = '', String phone = ''}) =>
    AccountProfile(
      key: AccountKey(network: net, id: id),
      displayName: name.isEmpty ? 'n$id' : name,
      phone: phone,
      updatedAt: id * 1000,
    );

void main() {
  late InMemoryAccountsStore store;
  late AccountRegistry registry;

  setUp(() {
    store = InMemoryAccountsStore();
    registry = AccountRegistry(store: store);
  });

  tearDown(() async {
    await registry.dispose();
  });

  test('load() is required before any access', () {
    expect(
      () => registry.profiles,
      throwsStateError,
    );
    expect(registry.isLoaded, isFalse);
  });

  test('add() persists and emits added event', () async {
    await registry.load();
    final events = <AccountRegistryEvent>[];
    final sub = registry.events.listen(events.add);
    await registry.add(profile(Network.max, 2));
    await Future<void>.delayed(Duration.zero);
    expect(registry.profiles, hasLength(1));
    expect(events.map((e) => e.kind), [
      AccountRegistryEventKind.added,
      AccountRegistryEventKind.activeChanged,
    ]);
    await sub.cancel();
  });

  test('first added account becomes active', () async {
    await registry.load();
    final events = <AccountRegistryEvent>[];
    final sub = registry.events.listen(events.add);
    await registry.add(profile(Network.max, 1));
    await Future<void>.delayed(Duration.zero);
    expect(registry.activeKey, const AccountKey(network: Network.max, id: 1));
    expect(
      events.map((e) => e.kind),
      containsAll([AccountRegistryEventKind.added, AccountRegistryEventKind.activeChanged]),
    );
    await sub.cancel();
  });

  test('second added account does not steal active', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1));
    await registry.add(profile(Network.max, 2));
    expect(registry.activeKey, const AccountKey(network: Network.max, id: 1));
  });

  test('add() of existing key merges non-empty fields', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1, name: 'Old', phone: '+1'));
    await registry.add(profile(Network.max, 1, name: 'New'));
    final p = registry.profileOf(const AccountKey(network: Network.max, id: 1))!;
    expect(p.displayName, 'New');
    expect(p.phone, '+1');
    expect(registry.profiles, hasLength(1));
  });

  test('remove() drops the profile and clears active when needed', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1));
    await registry.add(profile(Network.max, 2));
    await registry.setActive(const AccountKey(network: Network.max, id: 2));
    await registry.remove(const AccountKey(network: Network.max, id: 2));
    expect(registry.profiles, hasLength(1));
    expect(registry.activeKey, isNull);
  });

  test('remove() of missing key is a no-op', () async {
    await registry.load();
    await registry.remove(const AccountKey(network: Network.max, id: 99));
    expect(registry.profiles, isEmpty);
  });

  test('setActive() persists the choice', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1));
    await registry.add(profile(Network.max, 2));
    await registry.setActive(const AccountKey(network: Network.max, id: 2));

    final second = AccountRegistry(store: store);
    await second.load();
    expect(
      second.activeKey,
      const AccountKey(network: Network.max, id: 2),
    );
    await second.dispose();
  });

  test('setActive() ignores unknown keys', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1));
    await registry.setActive(const AccountKey(network: Network.telegram, id: 5));
    expect(registry.activeKey, const AccountKey(network: Network.max, id: 1));
  });

  test('registry state survives a store round-trip', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1, name: 'One'));
    await registry.add(profile(Network.telegram, 4, name: 'Four'));

    final revived = AccountRegistry(store: store);
    await revived.load();
    expect(revived.profiles, hasLength(2));
    expect(
      revived.profileOf(const AccountKey(network: Network.telegram, id: 4))!
          .displayName,
      'Four',
    );
    await revived.dispose();
  });

  test('profiles list is sorted and unmodifiable', () async {
    await registry.load();
    await registry.add(profile(Network.telegram, 3));
    await registry.add(profile(Network.max, 8));
    await registry.add(profile(Network.max, 1));
    expect(
      registry.profiles.map((p) => p.key.storageId).toList(),
      ['max:1', 'max:8', 'tg:3'],
    );
    expect(
      () => registry.profiles.add(profile(Network.max, 2)),
      throwsUnsupportedError,
    );
  });

  test('update() rewrites stored fields', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1, name: 'Old'));
    await registry.update(profile(Network.max, 1, name: 'New'));
    expect(
      registry.profileOf(const AccountKey(network: Network.max, id: 1))!
          .displayName,
      'New',
    );
  });

  test('update() of unknown key is a no-op', () async {
    await registry.load();
    await registry.update(profile(Network.max, 9));
    expect(registry.profiles, isEmpty);
  });

  test('load() twice is idempotent', () async {
    await registry.load();
    await registry.add(profile(Network.max, 1));
    await registry.load();
    expect(registry.profiles, hasLength(1));
  });
}
