/// Antiban rate limiter for MAX phone lookups (plan-v3 Т-1.8, правила 4.8).
///
/// `lookupPhone` maps to upstream AccountModule.requestCode (Opcode
/// .authRequest=17 — authRequest отправляется только здесь, телефон входит
/// в payload). Чек-лист 6.4: «Антибан: тест rate-limiter; 20 lookup подряд
/// → очередь». The limiter is injectable into any request path; UI gets its
/// indication through a stream (source-agnostic, like BackendEvent).
library;

import 'dart:async';

/// Identication of what is being rate-limited (lookup phones now; other
/// antiban queues can be added by name).
enum RateLimitKind { phoneLookup }

class RateLimitStatus {
  final RateLimitKind kind;

  /// Remaining attempts inside the current burst.
  final int remaining;

  /// Position in the queue when the request was queued (0 = не в очереди).
  final int queuePosition;

  /// Delay before the queued request runs; null for immediate ones.
  final Duration? wait;

  const RateLimitStatus({
    required this.kind,
    required this.remaining,
    this.queuePosition = 0,
    this.wait,
  });

  bool get queued => queuePosition > 0;
}

/// Executes one rate-limited request. Returns the request's result.
typedef RateLimitedCall<T> = Future<T> Function();

abstract class AntibanRateLimiter {
  Stream<RateLimitStatus> get statusStream;
}

/// Burst-then-queue limiter: [burstSize] requests run immediately; the
/// rest wait in a FIFO queue and drain one per [cooldown]. Mirrors the
/// plan rule «20 lookup подряд → очередь».
class BurstRateLimiter<T> implements AntibanRateLimiter {
  final RateLimitKind kind;
  final int burstSize;
  final Duration cooldown;
  final Future<void> Function(Duration delay) sleeper;

  final _statusController = StreamController<RateLimitStatus>.broadcast();

  int _burstUsed = 0;
  DateTime _burstStart = DateTime.fromMillisecondsSinceEpoch(0);
  final _queue = <Completer<void>>[];

  BurstRateLimiter({
    required this.kind,
    this.burstSize = 20,
    required this.cooldown,
    Future<void> Function(Duration delay)? sleeper,
  }) : sleeper = sleeper ?? Future<void>.delayed;

  @override
  Stream<RateLimitStatus> get statusStream => _statusController.stream;

  int get queuedCount => _queue.length;

  int get burstRemaining => burstSize - _burstUsed;

  /// Runs [call] respecting the limit: inside the burst — immediately;
  /// beyond it — queued behind earlier requests, one per cooldown tick.
  Future<T> run(RateLimitedCall<T> call) async {
    _maybeResetBurst();
    if (_burstUsed < burstSize && _queue.isEmpty) {
      _burstUsed++;
      _emit(RateLimitStatus(kind: kind, remaining: burstSize - _burstUsed));
      return call();
    }
    final position = _queue.length + 1;
    final wait = cooldown * position;
    _emit(RateLimitStatus(
      kind: kind,
      remaining: 0,
      queuePosition: position,
      wait: wait,
    ));
    final turn = Completer<void>();
    _queue.add(turn);
    await _awaitTurn(turn);
    try {
      return await call();
    } finally {
      _advanceQueue();
    }
  }

  Future<void> _awaitTurn(Completer<void> turn) {
    final head = _queue.first;
    if (identical(head, turn)) {
      return Future<void>.value();
    }
    return turn.future;
  }

  void _advanceQueue() {
    _queue.removeAt(0);
    if (_queue.isNotEmpty) {
      unawaited(_drainNext());
    }
  }

  Future<void> _drainNext() async {
    final delay = cooldown;
    unawaited(sleeper(delay).then((_) {
      final head = _queue.firstOrNull;
      if (head != null && !head.isCompleted) {
        head.complete();
      }
    }));
  }

  void _maybeResetBurst() {
    final now = DateTime.now();
    final window = _burstStart == DateTime.fromMillisecondsSinceEpoch(0)
        ? null
        : cooldown * 2;
    if (window == null) {
      _burstStart = now;
      return;
    }
    if (now.difference(_burstStart) >= window) {
      _burstUsed = 0;
      _burstStart = now;
    }
  }

  void _emit(RateLimitStatus status) {
    if (!_statusController.isClosed) {
      _statusController.add(status);
    }
  }

  Future<void> dispose() => _statusController.close();
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
