/// Dart side of ConnectionForegroundService (plan-v3 Т-1.9).
///
/// The Kotlin service keeps the process and a background Flutter engine
/// alive; this controller receives platform signals (reconnect / pause /
/// connected-account counts) over the MethodChannel
/// `ru.wellmagram.app/connection` and drives the SessionManager. The
/// channel is a seam ([ConnectionChannelLike]) so the controller logic is
/// unit-testable without the plugin layer.
library;

import 'dart:async';

import 'package:wellmagram/core/app/session_manager.dart';

/// MethodChannel seam: platform → Dart invocations.
abstract class ConnectionChannelLike {
  Stream<String> get signals;
  void pushAccountsConnected(int count);
}

/// Reconnect backoff policy (must mirror ConnectionEngine.backoffDelayMs:
/// base 1s doubling, capped at max).
class ReconnectBackoff {
  final Duration base;
  final Duration max;

  const ReconnectBackoff({
    this.base = const Duration(seconds: 1),
    this.max = const Duration(minutes: 1),
  });

  Duration delayFor(int attempt) {
    if (attempt <= 0) return base;
    var ms = base.inMilliseconds;
    for (var i = 1; i < attempt; i++) {
      ms *= 2;
      if (ms >= max.inMilliseconds) return max;
    }
    return Duration(milliseconds: ms);
  }
}

class ConnectionServiceController {
  final ConnectionChannelLike channel;
  final SessionManager sessionManager;
  final ReconnectBackoff backoff;

  final _stateController = StreamController<ConnectionServiceState>.broadcast();

  ConnectionServiceController({
    required this.channel,
    required this.sessionManager,
    this.backoff = const ReconnectBackoff(),
  }) {
    channel.signals.listen(_handleSignal);
  }

  Stream<ConnectionServiceState> get states => _stateController.stream;

  bool _paused = false;
  int _connectedAccounts = 0;

  bool get isPaused => _paused;
  int get connectedAccounts => _connectedAccounts;

  void _handleSignal(String signal) {
    switch (signal) {
      case 'reconnect':
        if (!_paused) {
          _emit(const ConnectionServiceState.reconnecting());
        }
      case 'pause':
        _paused = true;
        for (final account in sessionManager.liveAccounts) {
          sessionManager.pause(account);
        }
        _emit(const ConnectionServiceState.paused());
      default:
        break;
    }
  }

  /// The session layer reports how many accounts are online; the controller
  /// forwards the count to the platform notification.
  void reportConnectedAccounts(int count) {
    _connectedAccounts = count;
    channel.pushAccountsConnected(count);
    _emit(ConnectionServiceState.online(count));
  }

  void resume() {
    _paused = false;
    _emit(const ConnectionServiceState.reconnecting());
  }

  void _emit(ConnectionServiceState state) {
    if (!_stateController.isClosed) {
      _stateController.add(state);
    }
  }

  Future<void> dispose() => _stateController.close();
}

class ConnectionServiceState {
  final ConnectionServiceKind kind;
  final int accounts;

  const ConnectionServiceState._(this.kind, this.accounts);

  const ConnectionServiceState.reconnecting()
      : this._(ConnectionServiceKind.reconnecting, 0);

  const ConnectionServiceState.paused()
      : this._(ConnectionServiceKind.paused, 0);

  const ConnectionServiceState.online(int accounts)
      : this._(ConnectionServiceKind.online, accounts);

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ConnectionServiceState &&
          other.kind == kind &&
          other.accounts == accounts;

  @override
  int get hashCode => Object.hash(kind, accounts);
}

enum ConnectionServiceKind { reconnecting, paused, online }
