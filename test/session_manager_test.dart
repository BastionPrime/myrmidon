import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/accounts/spoof_bridge.dart';
import 'package:wellmagram/core/app/session_manager.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_backend.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/storage/spoof_profile_store.dart';
import 'package:test/test.dart';

import 'fake_max_api.dart';
import 'in_memory_secure_storage.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const max2 = AccountKey(network: Network.max, id: 2);
const tg3 = AccountKey(network: Network.telegram, id: 3);

class BackendRecord {
  final FakeMaxApi api = FakeMaxApi();
  late final MaxBackend backend = MaxBackend(
    account: account,
    api: api,
    credentials: credentials,
    specBuilder: SessionSpecBuilder(
      loadSpoofProfile: (a) async => const {
        'deviceId': 'd',
        'appVersion': '26.23.2',
        'buildNumber': 6779,
      },
      loadEndpoint: () async => (host: 'api2.oneme.ru', port: 443),
      loadProxyUrl: () async => null,
    ),
  );
  final AccountKey account;
  final CredentialStore credentials;

  BackendRecord(this.account, this.credentials);
}

class FakeSpoofStore extends SpoofProfileStore {
  final removed = <AccountKey>[];

  FakeSpoofStore()
      : super(
          prefs: _MapPrefs(),
          random: SeededSpoofRandom(42),
        );

  @override
  Future<bool> remove(AccountKey account) async {
    removed.add(account);
    return true;
  }
}

class _MapPrefs implements SpoofPrefsLike {
  final Map<String, String> data = {};

  @override
  String? getString(String key) => data[key];

  @override
  Future<void> setString(String key, String value) async => data[key] = value;

  @override
  Future<void> remove(String key) async => data.remove(key);
}

class Harness {
  final secureStorage = InMemorySecureStorage();
  late final CredentialStore credentials = CredentialStore(secureStorage);
  final records = <AccountKey, BackendRecord>{};
  final createdOrder = <AccountKey>[];

  late final SessionManager manager = SessionManager(
    mode: mode,
    factory: (account) {
      final record = BackendRecord(account, credentials);
      records[account] = record;
      createdOrder.add(account);
      return record.backend;
    },
  );

  final SessionMode mode;

  Harness(this.mode);

  Future<void> login(AccountKey account, String token) async {
    final existing = secureStorage.data['cred:${account.storageId}'];
    if (existing == null) {
      await credentials.saveToken(account, token);
    }
  }
}

Future<void> pump() => Future<void>.delayed(Duration.zero);

void main() {
  test('switch mode: start pauses the previous session and lifts the new one',
      () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');

    final first = await h.manager.start(max1);
    await pump();
    expect(first.state, BackendState.online);
    expect(h.manager.activeKey, max1);

    final second = await h.manager.start(max2);
    await pump();
    expect(second.state, BackendState.online);
    expect(first.state, BackendState.paused);
    expect(h.manager.activeKey, max2);
    await h.manager.dispose();
  });

  test('switch mode keeps one backend per account across re-selects',
      () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');

    await h.manager.start(max1);
    await h.manager.start(max2);
    final again = await h.manager.start(max1);

    expect(h.createdOrder, [max1, max2]);
    expect(again, same(h.records[max1]!.backend));
    expect(h.records[max2]!.backend.state, BackendState.paused);
    await h.manager.dispose();
  });

  test('parallel mode: switching does not pause the other session',
      () async {
    final h = Harness(SessionMode.parallel);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');

    final first = await h.manager.start(max1);
    await h.manager.start(max2);
    await pump();

    expect(first.state, BackendState.online);
    expect(h.manager.activeKey, max2);
    expect(h.manager.isParallel, isTrue);
    await h.manager.dispose();
  });

  test('onSwitcherSelected matches the overlay callback contract',
      () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');

    void Function(int? accountId) callback = (id) {
      unawaited(h.manager.onSwitcherSelected(id));
    };
    callback(1);
    await pump();
    await pump();
    expect(h.manager.activeKey, max1);
    expect(h.records[max1]!.api.lastLoginToken, 'token-1');

    callback(null);
    await pump();
    expect(h.manager.activeKey, isNull);
    expect(h.records[max1]!.backend.state, BackendState.online);
    await h.manager.dispose();
  });

  test('active account changes stream out', () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');

    final seen = <AccountKey?>[];
    final sub = h.manager.activeChanges.listen(seen.add);
    await h.manager.start(max1);
    await h.manager.start(max2);
    await pump();
    expect(seen, containsAll([max1, max2]));
    await sub.cancel();
    await h.manager.dispose();
  });

  test('ghost mode applies to live sessions and to later starts',
      () async {
    final h = Harness(SessionMode.parallel);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');

    await h.manager.start(max1);
    await h.manager.setGhostMode(true);
    expect(h.records[max1]!.api.lastGhostMode, isTrue);

    final second = await h.manager.start(max2);
    await pump();
    expect(h.records[max2]!.api.lastGhostMode, isTrue,
        reason: 'сессия, поднятая в ghost-режиме, должна получить '
            'pingInteractive=false (замечание ревью для Т-1.7)');
    expect(second.state, BackendState.online);
    await h.manager.dispose();
  });

  test('pause and resume keep the credential login', () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    final backend = await h.manager.start(max1);
    await h.manager.pause(max1);
    expect(backend.state, BackendState.paused);

    await h.manager.resume(max1);
    await pump();
    expect(backend.state, BackendState.online);
    expect(h.records[max1]!.api.lastLoginToken, 'token-1');
    expect(h.manager.activeKey, max1);
    await h.manager.dispose();
  });

  test('removeAccount disposes the backend, drops credentials and spoof',
      () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    await h.login(max2, 'token-2');
    await h.manager.start(max1);
    await h.manager.start(max2);

    final spoofStore = FakeSpoofStore();
    final removed = await h.manager.removeAccount(
      max2,
      credentials: h.credentials,
      spoofBridge: SpoofStoreBridge(spoofStore) as AccountSpoofStoreBridge,
    );

    expect(removed, isTrue);
    expect(h.records[max2]!.api.disposed, isTrue);
    expect(h.manager.backendOf(max2), isNull);
    expect(h.manager.activeKey, isNull);
    expect(h.secureStorage.data.containsKey('cred:max:2'), isFalse);
    expect(spoofStore.removed, [max2]);
    expect(h.manager.backendOf(max1), isNotNull);
    await h.manager.dispose();
  });

  test('removeAccount keeps the active account when removing another',
      () async {
    final h = Harness(SessionMode.switchMode);
    await h.login(max1, 'token-1');
    await h.manager.start(max1);

    final removed = await h.manager.removeAccount(
      max2,
      credentials: h.credentials,
      spoofBridge: _NoopBridge(),
    );
    expect(removed, isFalse);
    expect(h.manager.activeKey, max1);
    await h.manager.dispose();
  });

  test('telegram accounts are rejected explicitly', () async {
    final h = Harness(SessionMode.switchMode);
    expect(h.manager.start(tg3), throwsUnsupportedError);
    await h.manager.dispose();
  });

  test('dispose tears everything down once', () async {
    final h = Harness(SessionMode.parallel);
    await h.login(max1, 'token-1');
    await h.manager.start(max1);
    await h.manager.dispose();
    expect(h.records[max1]!.api.disposed, isTrue);
    expect(() => h.manager.start(max1), throwsStateError);
    expect(h.manager.liveAccounts, isEmpty);
  });
}

class _NoopBridge implements AccountSpoofStoreBridge {
  @override
  Future<bool> remove(AccountKey account) async => false;
}
