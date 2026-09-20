/// TdBridge — the json client lifecycle manager over [TdClientLike]
/// (plan-v3 4.4 / Т-2.1): request/response correlation by `@extra`,
/// request timeouts, reconnect policy for the update feed, content-free
/// logging.
///
/// Responsibilities (from the plan):
/// - очередь запросов с `@extra`: every [send] gets a monotonically
///   increasing `@extra` token; responses carrying the same token resolve
///   the returned future.
/// - таймауты: requests that outlive [requestTimeout] complete with
///   [TdTimeoutException]; the pending entry is dropped, TDLib may still
///   answer late (a late answer for a dropped extra is ignored — no
///   unhandled path).
/// - реконнект: the update stream is re-armed through [TdReconnectPolicy]
///   when the underlying client reports a broken feed (error event from
///   the seam or stream done without destroy).
/// - отдельный изолят/поток апдейтов: the seam owns the native receive
///   thread; the bridge surfaces a single ordered [updates] stream for
///   the TelegramBackend (Т-2.3+) to map onto unified models.
/// - логирование без содержимого: [TdBridgeLog] receives only message
///   `@type` names, numeric ids and timings — never chat/message content,
///   never `databaseEncryptionKey`/api_hash.
///
/// The bridge is transport-agnostic (mock in tests, FFI/JNI adapter in the
/// build image — ADR-0001 keeps the choice open until live TDLib runs).
library;

import 'dart:async';

import 'td_client_seam.dart';

/// Thrown when a request exceeds [TdBridgeOptions.requestTimeout].
class TdTimeoutException implements Exception {
  final String method;
  final Duration timeout;

  const TdTimeoutException(this.method, this.timeout);

  @override
  String toString() => 'TdTimeoutException: $method timed out after $timeout';
}

/// A TDLib `error` object { @type: 'error', code, message } surfaced as a
/// failed future for the originating request.
class TdErrorException implements Exception {
  final int code;
  final String message;

  const TdErrorException(this.code, this.message);

  @override
  String toString() => 'TdErrorException($code): $message';
}

/// Content-free log interface (Т-2.1: «логирование без содержимого»).
/// Implementations must not receive chat/message bodies, phone numbers,
/// the database encryption key or api_hash.
abstract class TdBridgeLog {
  void onSend(String method);

  void onResult(String method, Duration elapsed);

  void onTimeout(String method, Duration timeout);

  void onErrorEvent(int code);

  /// Update traffic log: only the `@type` of the update.
  void onUpdate(String updateType);

  /// Reconnect attempt fired by the policy.
  void onReconnect(int attempt);

  void onDisposed();
}

/// No-op log; safe default for production code that has no logger wired.
final class TdNullLog implements TdBridgeLog {
  const TdNullLog();

  @override
  void onSend(String method) {}

  @override
  void onResult(String method, Duration elapsed) {}

  @override
  void onTimeout(String method, Duration timeout) {}

  @override
  void onErrorEvent(int code) {}

  @override
  void onUpdate(String updateType) {}

  @override
  void onReconnect(int attempt) {}

  @override
  void onDisposed() {}
}

class TdBridgeOptions {
  /// Per-request timeout for `@extra`-correlated futures.
  final Duration requestTimeout;

  /// Reconnect policy of the update feed.
  final TdReconnectPolicy reconnectPolicy;

  const TdBridgeOptions({
    this.requestTimeout = const Duration(seconds: 30),
    this.reconnectPolicy = const TdReconnectPolicy(),
  });
}

/// Correlation entry for one in-flight request.
class _Pending {
  final String method;
  final Completer<Map<String, dynamic>> completer;
  final Stopwatch stopwatch;
  final Timer timer;

  _Pending(this.method, this.completer, this.stopwatch, this.timer);
}

class TdBridge {
  final TdClientLike client;
  final TdBridgeOptions options;
  final TdBridgeLog log;

  StreamSubscription<TdResponse>? _updateSub;

  /// `@extra` -> pending request. Monotonic token via [_nextExtra].
  final _pendingByExtra = <String, _Pending>{};
  int _nextExtra = 0;

  final _updateController = StreamController<Map<String, dynamic>>.broadcast();
  final _errorController = StreamController<void>.broadcast();

  bool _destroyed = false;
  bool _destroying = false;

  TdBridge({
    required this.client,
    this.options = const TdBridgeOptions(),
    this.log = const TdNullLog(),
  }) {
    _armUpdateFeed();
  }

  /// Ordered update feed (raw json `@type: update*` objects), as produced
  /// by the seam's dedicated receive loop. Responses to requests are NOT
  /// delivered here — they go to their futures through `@extra`.
  Stream<Map<String, dynamic>> get updates => _updateController.stream;

  /// Fires when the update feed is considered broken after the reconnect
  /// budget is exhausted (the backend should surface `disconnected`).
  Stream<void> get failures => _errorController.stream;

  bool get isDestroyed => _destroyed;

  /// Number of requests currently awaiting a response.
  int get pendingCount => _pendingByExtra.length;

  /// Sends a request and returns the response object (map) correlated by
  /// `@extra`. Throws [TdTimeoutException] after the request timeout and
  /// [TdErrorException] for a TDLib `error` response.
  Future<Map<String, dynamic>> send(Map<String, dynamic> request) {
    if (_destroyed || _destroying) {
      throw StateError('TdBridge: destroyed');
    }
    final method = request['@type'] is String ? request['@type'] as String : '';
    final extra = _allocExtra();
    final completer = Completer<Map<String, dynamic>>();
    final stopwatch = Stopwatch()..start();
    final pending = _Pending(
      method,
      completer,
      stopwatch,
      Timer(options.requestTimeout, () {
        final entry = _pendingByExtra.remove(extra);
        if (entry != null) {
          log.onTimeout(method, options.requestTimeout);
          entry.completer.completeError(
            TdTimeoutException(method, options.requestTimeout),
          );
        }
      }),
    );
    _pendingByExtra[extra] = pending;
    log.onSend(method);
    client.send({...request, '@extra': extra});
    return completer.future;
  }

  /// Synchronous execution for "Can be called synchronously" requests
  /// (`setLogVerbosityLevel`, etc.) — direct passthrough to the seam.
  TdResponse? execute(Map<String, dynamic> request) {
    if (_destroyed || _destroying) {
      throw StateError('TdBridge: destroyed');
    }
    return client.execute(request);
  }

  /// Applies [TdClientConfig] as the `setTdlibParameters` request through
  /// the standard `@extra` path (per-account directory and key, plan 4.4).
  Future<Map<String, dynamic>> applyParameters(TdClientConfig config) =>
      send(config.toSetTdlibParametersMap());

  Future<void> destroy() async {
    if (_destroyed || _destroying) return;
    _destroying = true;
    await _updateSub?.cancel();
    for (final pending in _pendingByExtra.values.toList()) {
      pending.timer.cancel();
      pending.completer.completeError(
        StateError('TdBridge: destroyed while $pending is in flight'),
      );
    }
    _pendingByExtra.clear();
    await client.destroy();
    _destroyed = true;
    log.onDisposed();
    if (!_updateController.isClosed) {
      await _updateController.close();
      await _errorController.close();
    }
  }

  void _armUpdateFeed() {
    _updateSub = client.updateStream.listen(
      _onResponse,
      onDone: () => _onFeedBroken('update stream done'),
      onError: (Object e) => _onFeedBroken('update stream error: $e'),
    );
  }

  void _onResponse(TdResponse response) {
    final extra = response.extra;
    if (extra != null && _pendingByExtra.containsKey(extra)) {
      _resolvePending(extra, response);
      return;
    }
    final type = response.type;
    if (type.startsWith('update') || type == 'updateAuthorizationState') {
      log.onUpdate(type);
      if (!_updateController.isClosed) {
        _updateController.add(response.json);
      }
      return;
    }
    // Unsolicited non-update response (late answer for a dropped extra or
    // a response without @extra): dropped deliberately, no content logged.
  }

  void _resolvePending(String extra, TdResponse response) {
    final pending = _pendingByExtra.remove(extra)!;
    pending.timer.cancel();
    pending.stopwatch.stop();
    log.onResult(pending.method, pending.stopwatch.elapsed);
    if (response.type == 'error') {
      final code = response.json['code'] is int ? response.json['code'] as int : 0;
      log.onErrorEvent(code);
      pending.completer.completeError(TdErrorException(code, messageOf(response.json)));
    } else {
      pending.completer.complete(response.json);
    }
  }

  /// Feed teardown without destroy: apply the reconnect policy; when the
  /// budget is exhausted emit on [failures] and keep the bridge unusable
  /// for updates until [destroy].
  Future<void> _onFeedBroken(String reason) async {
    if (_destroyed || _destroying) return;
    await _updateSub?.cancel();
    final policy = options.reconnectPolicy;
    for (var attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      log.onReconnect(attempt);
      await Future<void>.delayed(policy.delayFor(attempt));
      if (_destroyed || _destroying) return;
      final rearm = await _tryRearm();
      if (rearm) return;
    }
    if (!_errorController.isClosed) {
      _errorController.addError(StateError('TdBridge: update feed lost ($reason)'));
    }
  }

  /// Re-subscribes the update feed; a single sync event means the seam is
  /// alive again. The production seam restarts its receive thread here.
  Future<bool> _tryRearm() async {
    if (_destroyed || _destroying) return false;
    final alive = Completer<bool>();
    late final StreamSubscription<TdResponse> probe;
    probe = client.updateStream.listen(
      (event) {
        _onResponse(event);
        if (!alive.isCompleted) alive.complete(true);
      },
      onDone: () {
        if (!alive.isCompleted) alive.complete(false);
      },
      onError: (Object e) {
        if (!alive.isCompleted) alive.complete(false);
      },
    );
    final ok = await alive.future;
    await probe.cancel();
    if (ok && !_destroyed && !_destroying) {
      _armUpdateFeed();
      return true;
    }
    return false;
  }

  String _allocExtra() {
    _nextExtra++;
    return '$_nextExtra';
  }
}

/// Extracts the error message of a TDLib `error` object without exposing
/// any request payload (message text comes from TDLib itself, not content).
String messageOf(Map<String, dynamic> json) =>
    json['message'] is String ? json['message'] as String : '';
