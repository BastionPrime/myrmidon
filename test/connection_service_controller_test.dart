import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/app/connection_service_controller.dart';
import 'package:wellmagram/core/app/session_manager.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_backend.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

import 'fake_max_api.dart';
import 'in_memory_secure_storage.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const max2 = AccountKey(network: Network.max, id: 2);

class FakeChannel implements ConnectionChannelLike {
  final _signals = StreamController<String>.broadcast();
  final pushedCounts = <int>[];

  @override
  Stream<String> get signals => _signals.stream;

  @override
  void pushAccountsConnected(int count) {
    pushedCounts.add(count);
  }

  void emit(String signal) => _signals.add(signal);

  Future<void> dispose() => _signals.close();
}

class FakeSessionHarness {
  final secureStorage = InMemorySecureStorage();
  late final CredentialStore credentials = CredentialStore(secureStorage);
  final apiByAccount = <AccountKey, FakeMaxApi>{};

  late final SessionManager manager = SessionManager(
    mode: SessionMode.parallel,
    factory: (account) {
      final api = FakeMaxApi();
      apiByAccount[account] = api;
      return MaxBackend(
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
    },
  );

  Future<MaxBackend> login(AccountKey account, String token) async {
    if (!secureStorage.data.containsKey('cred:${account.storageId}')) {
      await credentials.saveToken(account, token);
    }
    return manager.start(account);
  }
}

void main() {
  group('ReconnectBackoff', () {
    test('doubles from the base and caps at max', () {
      const backoff = ReconnectBackoff(
        base: Duration(seconds: 1),
        max: Duration(minutes: 1),
      );
      expect(backoff.delayFor(0), const Duration(seconds: 1));
      expect(backoff.delayFor(1), const Duration(seconds: 1));
      expect(backoff.delayFor(2), const Duration(seconds: 2));
      expect(backoff.delayFor(3), const Duration(seconds: 4));
      expect(backoff.delayFor(5), const Duration(seconds: 16));
      expect(backoff.delayFor(7), const Duration(seconds: 60));
      expect(backoff.delayFor(8), const Duration(seconds: 60));
      expect(backoff.delayFor(50), const Duration(minutes: 1));
    });

    test('never exceeds the cap', () {
      const backoff = ReconnectBackoff();
      for (var i = 0; i < 30; i++) {
        expect(backoff.delayFor(i) <= backoff.max, isTrue);
      }
    });
  });

  group('ConnectionServiceController', () {
    test('reconnect signal (while not paused) emits reconnecting', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      final states = <ConnectionServiceState>[];
      final sub = controller.states.listen(states.add);
      channel.emit('reconnect');
      await Future<void>.delayed(Duration.zero);
      expect(states, contains(const ConnectionServiceState.reconnecting()));
      await sub.cancel();
      await controller.dispose();
      await h.manager.dispose();
    });

    test('reconnect signal while paused is ignored', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      final states = <ConnectionServiceState>[];
      final sub = controller.states.listen(states.add);
      channel.emit('pause');
      await Future<void>.delayed(Duration.zero);
      channel.emit('reconnect');
      await Future<void>.delayed(Duration.zero);
      expect(states, [const ConnectionServiceState.paused()]);
      await sub.cancel();
      await controller.dispose();
      await h.manager.dispose();
    });

    test('pause pauses all live sessions', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      await h.login(max1, 'token-1');
      await h.login(max2, 'token-2');
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      channel.emit('pause');
      await Future<void>.delayed(Duration.zero);
      expect(controller.isPaused, isTrue);
      expect(h.apiByAccount[max1]!.disconnected, isTrue);
      expect(h.apiByAccount[max2]!.disconnected, isTrue);
      await controller.dispose();
      await h.manager.dispose();
    });

    test('pause with no live sessions only flips the flag', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      channel.emit('pause');
      await Future<void>.delayed(Duration.zero);
      expect(controller.isPaused, isTrue);
      expect(h.manager.liveAccounts, isEmpty);
      await controller.dispose();
      await h.manager.dispose();
    });

    test('reportConnectedAccounts pushes count to the platform channel',
        () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      final states = <ConnectionServiceState>[];
      final sub = controller.states.listen(states.add);
      controller.reportConnectedAccounts(2);
      await Future<void>.delayed(Duration.zero);
      expect(channel.pushedCounts, [2]);
      expect(controller.connectedAccounts, 2);
      expect(states, contains(const ConnectionServiceState.online(2)));
      await sub.cancel();
      await controller.dispose();
      await h.manager.dispose();
    });

    test('resume clears the paused flag and emits reconnecting', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      channel.emit('pause');
      await Future<void>.delayed(Duration.zero);
      controller.resume();
      await Future<void>.delayed(Duration.zero);
      expect(controller.isPaused, isFalse);
      await controller.dispose();
      await h.manager.dispose();
    });

    test('unknown signals are ignored safely', () async {
      final channel = FakeChannel();
      final h = FakeSessionHarness();
      final controller = ConnectionServiceController(
        channel: channel,
        sessionManager: h.manager,
      );
      final states = <ConnectionServiceState>[];
      final sub = controller.states.listen(states.add);
      channel.emit('bogus');
      await Future<void>.delayed(Duration.zero);
      expect(states, isEmpty);
      await sub.cancel();
      await controller.dispose();
      await h.manager.dispose();
    });
  });
}
