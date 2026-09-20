import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/backends/max/antiban_rate_limiter.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_backend.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

import 'fake_max_api.dart';
import 'in_memory_secure_storage.dart';

const account = AccountKey(network: Network.max, id: 9);

class FakeClockSleeper {
  final List<Duration> slept = [];
  final Completer<void> drainSignal = Completer<void>();

  Future<void> call(Duration delay) {
    slept.add(delay);
    return Future<void>.value();
  }
}

class CountingApi extends FakeMaxApi {
  int lookups = 0;

  @override
  Future<List<MaxCachedMessage>> fetchHistory(
    int chatId, {
    int count = 50,
    int? backward,
  }) async {
    lookups++;
    return const [
      MaxCachedMessage(id: '1', chatId: 1, senderId: 1, text: 'x', time: 1),
    ];
  }
}

BurstRateLimiter<int> makeLimiter({
  int burst = 20,
  Duration cooldown = const Duration(milliseconds: 50),
  Future<void> Function(Duration)? sleeper,
}) =>
    BurstRateLimiter<int>(
      kind: RateLimitKind.phoneLookup,
      burstSize: burst,
      cooldown: cooldown,
      sleeper: sleeper,
    );

void main() {
  group('burst behaviour', () {
    test('burst window runs immediately up to the limit', () async {
      final limiter = makeLimiter(burst: 3);
      var ran = 0;
      for (var i = 0; i < 3; i++) {
        await limiter.run(() async => ran++);
      }
      expect(ran, 3);
      expect(limiter.queuedCount, 0);
      expect(limiter.burstRemaining, 0);
      await limiter.dispose();
    });

    test('the request past the burst is queued, not executed', () async {
      final limiter = makeLimiter(burst: 2);
      final results = <Future<int>>[];
      for (var i = 0; i < 3; i++) {
        results.add(limiter.run(() async => i));
      }
      final queuedBeforeDrain = limiter.queuedCount;
      expect(await results[0], 0);
      expect(await results[1], 1);
      expect(queuedBeforeDrain, 1);
      await limiter.dispose();
    });

    test('20 lookups in a row: first 20 immediate, 21st queued (6.4)', () async {
      final sleeper = FakeClockSleeper();
      final limiter = makeLimiter(burst: 20, sleeper: sleeper.call);
      var seenQueued = 0;
      final futures = [
        for (var i = 0; i < 21; i++) limiter.run(() async {
              if (limiter.queuedCount > seenQueued) seenQueued = limiter.queuedCount;
              return i;
            }),
      ];
      final immediate = [
        for (var i = 0; i < 20; i++) await futures[i],
      ];
      expect(immediate, equals(List<int>.generate(20, (i) => i)));
      expect(await futures[20], 20);
      expect(seenQueued, 1, reason: '21-й lookup обязан побывать в очереди');
      await limiter.dispose();
    });

    test('queue drains FIFO preserving order', () async {
      final limiter = makeLimiter(burst: 1);
      final order = <int>[];
      final futures = [
        for (var i = 0; i < 4; i++)
          limiter.run(() async {
            order.add(i);
            return i;
          }),
      ];
      await Future.wait(futures);
      expect(order, [0, 1, 2, 3]);
      await limiter.dispose();
    });
  });

  group('status stream (UI-индикация)', () {
    test('immediate run reports remaining slots', () async {
      final limiter = makeLimiter(burst: 3);
      final statuses = <RateLimitStatus>[];
      final sub = limiter.statusStream.listen(statuses.add);
      await limiter.run(() async => 1);
      await Future<void>.delayed(Duration.zero);
      expect(statuses.last.remaining, 2);
      expect(statuses.last.queued, isFalse);
      await sub.cancel();
      await limiter.dispose();
    });

    test('queued run reports position and wait', () async {
      final limiter = makeLimiter(burst: 1);
      final statuses = <RateLimitStatus>[];
      final sub = limiter.statusStream.listen(statuses.add);
      await limiter.run(() async => 1);
      final queued = limiter.run(() async => 2);
      await Future<void>.delayed(Duration.zero);
      final last = statuses.last;
      expect(last.queued, isTrue);
      expect(last.queuePosition, 1);
      expect(last.wait, isNotNull);
      expect(await queued, 2);
      await sub.cancel();
      await limiter.dispose();
    });
  });

  group('integration with MaxBackend seam', () {
    test('a backend call passes through the limiter unchanged', () async {
      final api = CountingApi();
      final backend = MaxBackend(
        account: account,
        api: api,
        credentials: CredentialStore(InMemorySecureStorage()),
        specBuilder: SessionSpecBuilder(
          loadSpoofProfile: (a) async => null,
          loadEndpoint: () async => (host: 'api2.oneme.ru', port: 443),
          loadProxyUrl: () async => null,
        ),
      );
      final limiter = BurstRateLimiter<List<dynamic>>(
        kind: RateLimitKind.phoneLookup,
        burstSize: 2,
        cooldown: const Duration(milliseconds: 10),
      );
      var calls = 0;
      for (var i = 0; i < 3; i++) {
        await limiter.run(() async {
          calls++;
          return await backend.history('c:1', limit: 1);
        });
      }
      expect(calls, 3);
      expect(api.lookups, 3);
      await backend.dispose();
      await limiter.dispose();
    });

    test('limiter status is source-agnostic like BackendEvent', () {
      final limiter = makeLimiter();
      final s = limiter.statusStream;
      expect(s, isA<Stream<RateLimitStatus>>());
      expect(
        RateLimitStatus(
          kind: RateLimitKind.phoneLookup,
          remaining: 1,
        ).toString(),
        isNot(contains('fcm')),
      );
      // no transport-source field on the model:
      expect(
        RateLimitStatus(
          kind: RateLimitKind.phoneLookup,
          remaining: 1,
        ).runtimeType.toString(),
        isNot(contains('Transport')),
      );
      limiter.dispose();
    });
  });
}
