/// Session lifecycle management for MAX accounts (plan-v3 Т-1.7).
///
/// Modes (plan 4.2):
/// - switch: exactly one live MAX session, the active account; switching
///   pauses the old backend and resumes the new one (upstream switchAccount
///   semantics, but per-account instead of a shared Api).
/// - parallel: all accounts keep live sessions (ADR-0003 gate, plan 4.6).
///
/// The account_switcher_overlay integration: the overlay's callback is
/// `void Function(int? accountId)` — SessionManager exposes
/// [onSwitcherSelected] with exactly that shape, translating the MAX id
/// into an AccountKey, so the overlay's external behaviour stays unchanged.
library;

import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/accounts/spoof_bridge.dart';
import 'package:wellmagram/core/backends/max/max_backend.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart';

enum SessionMode { switchMode, parallel }

class SessionManager {
  final SessionMode mode;
  final MaxBackendFactory backendFactory;

  final _backends = <AccountKey, MaxBackend>{};
  final _activeController = StreamController<AccountKey?>.broadcast();
  AccountKey? _activeKey;
  bool _disposed = false;
  bool _ghostMode = false;

  SessionManager({
    this.mode = SessionMode.switchMode,
    required MaxBackendFactory factory,
  }) : backendFactory = factory;

  Stream<AccountKey?> get activeChanges => _activeController.stream;

  AccountKey? get activeKey => _activeKey;

  bool get isParallel => mode == SessionMode.parallel;

  List<AccountKey> get liveAccounts => List.unmodifiable(_backends.keys);

  MaxBackend? backendOf(AccountKey account) => _backends[account];

  bool get isGhostMode => _ghostMode;

  /// Starts the session for the account; in switch mode any previous live
  /// session is paused first (one live MAX session), in parallel mode it
  /// stays online. Returns the started backend.
  Future<MaxBackend> start(AccountKey account) async {
    _requireAlive();
    if (account.network != Network.max) {
      throw UnsupportedError(
        'SessionManager Т-1.7: MAX-менеджер, tg-сессиями управляет Т-2.x',
      );
    }
    if (mode == SessionMode.switchMode && _activeKey != null && _activeKey != account) {
      await pause(_activeKey!);
    }
    var backend = _backends[account];
    if (backend == null) {
      backend = backendFactory.call(account);
      _backends[account] = backend;
    }
    await _startBackend(backend);
    _activeKey = account;
    _activeController.add(account);
    return backend;
  }

  Future<void> _startBackend(MaxBackend backend) async {
    if (backend.state == BackendState.disconnected) {
      await backend.connectAndLogin();
    } else {
      await backend.resume();
    }
    if (_ghostMode) {
      await backend.setGhostMode(true);
    }
  }

  /// The overlay callback: `void Function(int? accountId)` — MAX id in,
    /// session out. `null` (the overlay's "no account" signal) only drops
  /// the active marker without touching sessions.
  Future<void> onSwitcherSelected(int? accountId) async {
    _requireAlive();
    if (accountId == null) {
      _activeKey = null;
      _activeController.add(null);
      return;
    }
    await start(AccountKey(network: Network.max, id: accountId));
  }

  Future<void> pause(AccountKey account) async {
    final backend = _backends[account];
    if (backend != null && backend.state != BackendState.paused) {
      await backend.pause();
    }
  }

  Future<void> resume(AccountKey account) async {
    final backend = _backends[account];
    if (backend == null) {
      await start(account);
      return;
    }
    await _startBackend(backend);
    _activeKey = account;
    _activeController.add(account);
  }

  /// Ghost mode applies to every live session now and to any session
  /// started later (review note for Т-1.7: a session raised while ghost is
  /// on must come up with pingInteractive=false — here it is applied right
  /// after resume, before the account becomes active).
  Future<void> setGhostMode(bool enabled) async {
    _requireAlive();
    _ghostMode = enabled;
    for (final backend in _backends.values) {
      if (backend.state != BackendState.paused) {
        await backend.setGhostMode(enabled);
      }
    }
  }

  /// Full account removal (plan 4.7 п.8): session + credentials + spoof
  /// profile all go away together. The registry remove (T-1.1) and
  /// database/media removal (T-1.5) are orchestrated by the caller.
  Future<bool> removeAccount(
    AccountKey account, {
    required CredentialStore credentials,
    required AccountSpoofStoreBridge spoofBridge,
  }) async {
    _requireAlive();
    final backend = _backends.remove(account);
    if (backend != null) {
      await backend.dispose();
    }
    if (_activeKey == account) {
      _activeKey = null;
      _activeController.add(null);
    }
    var removed = await credentials.deleteAccountCredentials(account);
    final spoofRemoved = await spoofBridge.remove(account);
    return removed || spoofRemoved;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    for (final backend in _backends.values) {
      await backend.dispose();
    }
    _backends.clear();
    await _activeController.close();
  }

  void _requireAlive() {
    if (_disposed) {
      throw StateError('SessionManager: disposed');
    }
  }
}

typedef MaxBackendFactory = MaxBackend Function(AccountKey account);
