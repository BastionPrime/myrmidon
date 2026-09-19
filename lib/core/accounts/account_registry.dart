/// In-memory registry of known accounts, persisted to SharedPreferences as
/// JSON without secrets (S2) and emitting change events for the app layer.
library;

import 'dart:async';

import 'account_key.dart';
import 'account_profile.dart';
import 'account_registry_event.dart';
import 'accounts_store.dart';

class AccountRegistry {
  final AccountsStore _store;

  final Map<AccountKey, AccountProfile> _profiles = {};
  AccountKey? _activeKey;

  final _controller = StreamController<AccountRegistryEvent>.broadcast();
  bool _loaded = false;

  AccountRegistry({AccountsStore? store}) : _store = store ?? PrefsAccountsStore();

  Stream<AccountRegistryEvent> get events => _controller.stream;

  List<AccountProfile> get profiles {
    _requireLoaded();
    final list = _profiles.values.toList()..sort();
    return List.unmodifiable(list);
  }

  AccountProfile? profileOf(AccountKey key) {
    _requireLoaded();
    return _profiles[key];
  }

  AccountKey? get activeKey {
    _requireLoaded();
    return _activeKey;
  }

  bool get isLoaded => _loaded;

  Future<void> load() async {
    if (_loaded) return;
    final snapshot = await _store.read();
    _profiles
      ..clear()
      ..addEntries([for (final p in snapshot.profiles) MapEntry(p.key, p)]);
    _activeKey = snapshot.activeKey;
    _loaded = true;
  }

  Future<AccountProfile> add(AccountProfile profile) async {
    _requireLoaded();
    final existing = _profiles[profile.key];
    if (existing != null) {
      final merged = existing.copyWith(
        displayName: profile.displayName.isNotEmpty ? profile.displayName : null,
        phone: profile.phone.isNotEmpty ? profile.phone : null,
        updatedAt: profile.updatedAt != 0 ? profile.updatedAt : null,
      );
      _profiles[profile.key] = merged;
      await _persist();
      _emit(AccountRegistryEventKind.updated, profile.key);
      return merged;
    }
    _profiles[profile.key] = profile;
    if (_activeKey == null) {
      _activeKey = profile.key;
      await _persist();
      _emit(AccountRegistryEventKind.added, profile.key);
      _emit(AccountRegistryEventKind.activeChanged, profile.key);
      return profile;
    }
    await _persist();
    _emit(AccountRegistryEventKind.added, profile.key);
    return profile;
  }

  Future<void> remove(AccountKey key) async {
    _requireLoaded();
    if (_profiles.remove(key) == null) return;
    var activeChanged = false;
    if (_activeKey == key) {
      _activeKey = null;
      activeChanged = true;
    }
    await _persist();
    _emit(AccountRegistryEventKind.removed, key);
    if (activeChanged) {
      _emit(AccountRegistryEventKind.activeChanged, key);
    }
  }

  Future<void> update(AccountProfile profile) async {
    _requireLoaded();
    if (_profiles[profile.key] == null) return;
    _profiles[profile.key] = profile;
    await _persist();
    _emit(AccountRegistryEventKind.updated, profile.key);
  }

  Future<void> setActive(AccountKey key) async {
    _requireLoaded();
    if (_activeKey == key) return;
    if (!_profiles.containsKey(key)) return;
    _activeKey = key;
    await _persist();
    _emit(AccountRegistryEventKind.activeChanged, key);
  }

  Future<void> _persist() async {
    await _store.write(
      profiles: _profiles.values.toList(),
      activeKey: _activeKey,
    );
  }

  void _emit(AccountRegistryEventKind kind, AccountKey key) {
    if (!_controller.isClosed) {
      _controller.add(AccountRegistryEvent(kind: kind, key: key));
    }
  }

  void _requireLoaded() {
    if (!_loaded) {
      throw StateError('AccountRegistry: load() must complete before use');
    }
  }

  Future<void> dispose() => _controller.close();
}
