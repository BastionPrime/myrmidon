/// Bridges the spoof store (Т-1.6) to the backend session builder (Т-1.4):
/// SessionSpecBuilder expects `Future<Map<String, dynamic>?>` — SpoofProfile
/// serializes into exactly that map (upstream getSpoofedSessionData shape).
library;

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/storage/spoof_profile.dart';
import 'package:wellmagram/core/storage/spoof_profile_store.dart';

/// The map consumed by SessionSpecBuilder.loadSpoofProfile (fields follow
/// upstream getSpoofedSessionData: spoofing_service.dart:150-170).
Map<String, dynamic>? spoofProfileToSessionData(SpoofProfile? profile) {
  if (profile == null || !profile.enabled) return null;
  return {
    'device_name': profile.deviceName,
    'os_version': profile.osVersion,
    'screen': profile.screen,
    'timezone': profile.timezone,
    'locale': profile.locale,
    'device_locale': profile.deviceLocale,
    'device_id': profile.deviceId,
    'device_type': profile.deviceType,
    'app_version': profile.appVersion,
    'arch': profile.arch,
    'build_number': profile.buildNumber,
    'instance_id': profile.instanceId,
    'client_session_id': profile.clientSessionId,
    'push_device_type': profile.pushDeviceType,
    'user_agent': profile.userAgent,
  };
}

/// Narrow seam the SessionManager uses to drop a profile on account removal.
abstract class AccountSpoofStoreBridge {
  Future<bool> remove(AccountKey account);
}

class SpoofStoreBridge implements AccountSpoofStoreBridge {
  final SpoofProfileStore store;

  SpoofStoreBridge(this.store);

  @override
  Future<bool> remove(AccountKey account) => store.remove(account);

  /// Ready-made loader for SessionSpecBuilder.
  Future<Map<String, dynamic>?> loadSessionData(AccountKey account) async =>
      spoofProfileToSessionData(await store.load(account));
}
