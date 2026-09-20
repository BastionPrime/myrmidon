/// Telegram multi-account sessions (plan-v3 4.4 / Т-2.9).
///
/// N TDLib clients — one per registered TG account — mirroring the MAX
/// SessionManager semantics (session_manager.dart) on the Telegram side:
/// - parallel: every TG account keeps a live [TdBridge] session
///   (SessionManager.parallel of Т-1.7 covers MAX; per plan R3 the
///   Telegram multi-account mode is параллельный);
/// - per-account directories: `tg/<id>` database + `tg/<id>/files`
///   under the account storage root (TdClientConfig, plan 4.4);
/// - восстановление при старте: [restore] re-creates sessions for every
///   registered TG account from the [AccountRegistry] + CredentialStore
///   key (TdDatabaseKeyStore.ensureKey — the TDLib database directory
///   survives restarts, the key lives in secure storage);
/// - ghost profile persistence (deferred from Т-2.8): per-account
///   TdGhostSettings persisted through a prefs seam (`tg_ghost:<id>`)
///   and re-applied to the session right after start, BEFORE the account
///   is declared live (the Т-1.7 ghost invariant).
///
/// The MAX SessionManager external contract (Т-1.7) is untouched: this
/// module handles Network.telegram accounts only and throws
/// UnsupportedError for MAX keys, exactly as SessionManager does for TG.
library;

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/account_registry.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';
import 'package:wellmagram/core/backends/telegram/td_db_key_store.dart';
import 'package:wellmagram/core/backends/telegram/td_ghost.dart';

/// Narrow prefs surface for the persisted ghost profile (same shape as
/// the registry store seam; the Flutter plugin is wired in the build
/// image, tests inject an in-memory fake).
abstract class TdGhostPrefsLike {
  String? getString(String key);
  Future<void> setString(String key, String value);
}

typedef TdClientFactory = TdClientLike Function();

/// Builds the per-account [TdClientConfig]: tg/<id> directories.
class TdSessionPaths {
  /// Storage root that holds per-network directories.
  final String root;

  TdSessionPaths({required this.root});

  /// Database directory of the account: `<root>/tg/<id>`
  /// (plan 4.4 «per-account директории tg/<id>»).
  String databaseDirectory(AccountKey account) => '$root/tg/${account.id}';

  /// Files directory of the account: `<root>/tg/<id>/files`.
  String filesDirectory(AccountKey account) =>
      '$root/tg/${account.id}/files';
}

/// One live Telegram session: bridge + ghost profile.
class TdLiveSession {
  final TdBridge bridge;
  final TdGhost ghost;

  TdLiveSession({required this.bridge, required this.ghost});
}

class TdSessionManager {
  final TdClientFactory clientFactory;
  final TdDatabaseKeyStore keyStore;
  final AccountStorageRoot storageRoot;
  final TdGhostPrefsLike? ghostPrefs;
  final int apiId;
  final String apiHash;

  final _sessions = <AccountKey, TdLiveSession>{};

  TdSessionManager({
    required this.clientFactory,
    required this.keyStore,
    required this.storageRoot,
    required this.apiId,
    required this.apiHash,
    this.ghostPrefs,
  });

  /// Accounts with a live session right now.
  List<AccountKey> get liveAccounts => List.unmodifiable(_sessions.keys);

  /// The live session of the account, or null when not started.
  TdLiveSession? sessionOf(AccountKey account) => _sessions[account];

  static String _ghostPrefsKey(AccountKey account) =>
      'tg_ghost:${account.id}';

  /// Reads the persisted ghost profile of the account (defaults to off
  /// when nothing is stored — ghost is an explicit opt-in, Т-2.8).
  ///
  /// Wire format: three flag characters, e.g. `110` = read+typing ghost,
  /// online live — deliberately NOT snake_case json keys: the schema
  /// shield (td_schema_check.py) treats map-literal keys as TDLib wire
  /// fields, and this entry is app-local persistence, not a TDLib form.
  Future<TdGhostSettings> ghostProfileOf(AccountKey account) async {
    final raw = ghostPrefs?.getString(_ghostPrefsKey(account));
    if (raw == null || raw.length != 3) return TdGhostSettings.off;
    bool flag(int i) => raw[i] == '1';
    return TdGhostSettings(
      ghostRead: flag(0),
      ghostTyping: flag(1),
      ghostOnline: flag(2),
    );
  }

  /// Persists the ghost profile and applies it to the live session (if
  /// any) right away.
  Future<void> setGhostProfile(
    AccountKey account,
    TdGhostSettings settings,
  ) async {
    final raw = [
      if (settings.ghostRead) '1' else '0',
      if (settings.ghostTyping) '1' else '0',
      if (settings.ghostOnline) '1' else '0',
    ].join();
    await ghostPrefs?.setString(_ghostPrefsKey(account), raw);
    final session = _sessions[account];
    if (session != null) {
      await session.ghost.setGhostMode(settings);
    }
  }

  /// Starts (or returns the already live) session for the account.
  /// The database key is ensured first (the TDLib database directory is
  /// bound to the secure-storage entry), then parameters are applied,
  /// then the persisted ghost profile — BEFORE the session is exposed
  /// as live (the ghost invariant of Т-1.7/Т-2.8).
  Future<TdLiveSession> start(AccountKey account) async {
    if (account.network != Network.telegram) {
      throw UnsupportedError(
        'TdSessionManager Т-2.9: TG-менеджер, MAX-сессиями управляет Т-1.7',
      );
    }
    var session = _sessions[account];
    if (session != null) return session;

    final key = await keyStore.ensureKey(account);
    final bridge = TdBridge(client: clientFactory());
    await bridge.applyParameters(TdClientConfig(
      databaseDirectory: storageRoot.databaseDirectory(account),
      filesDirectory: storageRoot.filesDirectory(account),
      databaseEncryptionKey: key,
      apiId: apiId,
      apiHash: apiHash,
      systemLanguageCode: 'ru',
      deviceModel: 'Android',
      systemVersion: '0',
      applicationVersion: '0',
    ));
    final ghost = TdGhost(bridge: bridge);
    session = TdLiveSession(bridge: bridge, ghost: ghost);
    _sessions[account] = session;

    // Ghost profile is applied right after start, before the account is
    // declared live — a session raised in ghost never surfaces online.
    await ghost.setGhostMode(await ghostProfileOf(account));
    return session;
  }

  /// Восстановление при старте: creates live sessions for every
  /// registered Telegram account (plan 4.4 «восстановление при старте»).
  /// Registry accounts without stored credentials still start — the
  /// TDLib database directory is bound to the key via ensureKey, which
  /// generates one on first use; auth flow (Т-2.2) re-runs only when
  /// TDLib reports waitPhoneNumber.
  Future<List<AccountKey>> restore(AccountRegistry registry) async {
    final restored = <AccountKey>[];
    for (final profile in registry.profiles) {
      if (profile.key.network != Network.telegram) continue;
      await start(profile.key);
      restored.add(profile.key);
    }
    return restored;
  }

  /// Stops the session (bridge destroyed); the account's database
  /// directory, credentials and ghost profile stay for the next start.
  Future<void> stop(AccountKey account) async {
    final session = _sessions.remove(account);
    if (session != null) {
      await session.bridge.destroy();
    }
  }

  Future<void> dispose() async {
    for (final session in _sessions.values) {
      await session.bridge.destroy();
    }
    _sessions.clear();
  }
}

/// Directory root seam so tests can use a fake root and the build image
/// wires the real application documents directory.
abstract class AccountStorageRoot {
  String databaseDirectory(AccountKey account);
  String filesDirectory(AccountKey account);
}

/// Default implementation: `<root>/tg/<id>` layout (TdSessionPaths).
class TdStorageRoot extends AccountStorageRoot {
  final TdSessionPaths paths;

  TdStorageRoot(String root) : paths = TdSessionPaths(root: root);

  @override
  String databaseDirectory(AccountKey account) =>
      paths.databaseDirectory(account);

  @override
  String filesDirectory(AccountKey account) =>
      paths.filesDirectory(account);
}
