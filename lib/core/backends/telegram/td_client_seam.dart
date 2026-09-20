/// Seam over libtdjson (plan-v3 4.4 / Т-2.1): the raw JSON client of TDLib.
///
/// The real `td_json_client.h` C API is: `td_json_client_create` /
/// `td_json_client_send(void*, const char*)` /
/// `td_json_client_receive(void*, double timeout)` /
/// `td_json_client_execute(void*, const char*)` /
/// `td_json_client_destroy(void*)`. The production FFI binding (Dart FFI via
/// tdlib_ex or a Kotlin-JNI plugin — ADR-0001 decision) implements this
/// interface in the build image; tests inject [FakeTdClient] / scripted mock.
///
/// Contract notes mirrored from the header docs:
/// - `send` may be called from any thread, requests are JSON strings.
/// - `receive` must NOT be called from two threads at once; returning null
///   after the timeout is normal. TDLib advises a dedicated receive thread.
/// - `execute` runs only "Can be called synchronously" requests
///   (e.g. setLogVerbosityLevel, getApplicationConfig path).
library;

import 'dart:async';

/// A raw TDLib json response (update or request result) with the wire
/// `@extra` preserved so the bridge can match it back to its request.
class TdResponse {
  /// Raw decoded json object exactly as TDLib produced it.
  final Map<String, dynamic> json;

  const TdResponse(this.json);

  /// The value of the `@extra` field, if present.
  String? get extra => json['@extra'] is String ? json['@extra'] as String : null;

  /// `@type` of the response, e.g. `updateNewMessage`, `error`, `ok`.
  String get type => json['@type'] is String ? json['@type'] as String : '';
}

/// The seam over the libtdjson json client: one instance = one TDLib
/// client instance (per-account, plan 4.4 "N клиентов").
///
/// The bridge owns the receive loop; [receive] is only called from the
/// bridge's update isolate (via [updateStream]) — never from user code.
abstract class TdClientLike {
  /// Sends a request to the client. `request` must already carry `@type`;
  /// the bridge adds `@extra` before calling this.
  void send(Map<String, dynamic> request);

  /// Runs a synchronous ("Can be called synchronously") request such as
  /// `setLogVerbosityLevel`; returns null for a non-object/empty answer.
  TdResponse? execute(Map<String, dynamic> request);

  /// Updates and request results, in the order TDLib produced them
  /// (consistency requirement of the header). The implementation owns the
  /// dedicated receive thread/isolate; a single subscription is expected
  /// from the bridge.
  Stream<TdResponse> get updateStream;

  /// Closes the client: stops the receive loop and releases the native
  /// handle (`td_json_client_destroy`). After this, [send]/[execute] are
  /// invalid to call.
  Future<void> destroy();
}

/// Holds the per-account paths and parameters the production adapter will
/// pass to `setTdlibParameters` (field names/semantics from the official
/// TDLib docs: use_test_dc, database_directory, files_directory,
/// database_encryption_key, use_file_database, use_chat_info_database,
/// use_message_database, use_secret_chats, api_id, api_hash,
/// system_language_code, device_model, system_version, application_version).
class TdClientConfig {
  /// Absolute path of the per-account TDLib database directory
  /// (plan 4.4: `tg/<id>` under the account storage root).
  final String databaseDirectory;

  /// Absolute path of the per-account files directory.
  final String filesDirectory;

  /// Raw bytes of the database encryption key. Never logged, never
  /// serialized outside the CredentialStore boundary.
  final List<int> databaseEncryptionKey;

  final int apiId;

  /// api_hash — secret; transported as opaque string, never logged.
  final String apiHash;

  final String systemLanguageCode;
  final String deviceModel;
  final String systemVersion;
  final String applicationVersion;

  final bool useTestDc;

  const TdClientConfig({
    required this.databaseDirectory,
    required this.filesDirectory,
    required this.databaseEncryptionKey,
    required this.apiId,
    required this.apiHash,
    required this.systemLanguageCode,
    required this.deviceModel,
    required this.systemVersion,
    required this.applicationVersion,
    this.useTestDc = false,
  });

  /// The `setTdlibParameters` request body (json form). The key is not
  /// included here on purpose: the caller assembles the request through the
  /// bridge so every outgoing request is logged through one point.
  Map<String, dynamic> toSetTdlibParametersMap() => {
        '@type': 'setTdlibParameters',
        'use_test_dc': useTestDc,
        'database_directory': databaseDirectory,
        'files_directory': filesDirectory,
        'database_encryption_key': databaseEncryptionKey,
        'use_file_database': true,
        'use_chat_info_database': true,
        'use_message_database': true,
        'use_secret_chats': false,
        'api_id': apiId,
        'api_hash': apiHash,
        'system_language_code': systemLanguageCode,
        'device_model': deviceModel,
        'system_version': systemVersion,
        'application_version': applicationVersion,
      };
}

/// Reconnect policy for the receive loop (plan Т-2.1 "реконнект-политика"):
/// a crashed/stalled receive path re-arms with exponential backoff up to
/// [maxDelay], giving up (to the error stream) after [maxAttempts].
class TdReconnectPolicy {
  /// Base delay before the first re-arm.
  final Duration initialDelay;

  /// Upper bound of the exponential backoff.
  final Duration maxDelay;

  /// Maximum re-arm attempts before the bridge reports the failure.
  final int maxAttempts;

  /// Factor applied per attempt (delay * factor).
  final double backoffFactor;

  const TdReconnectPolicy({
    this.initialDelay = const Duration(milliseconds: 200),
    this.maxDelay = const Duration(seconds: 10),
    this.maxAttempts = 6,
    this.backoffFactor = 2.0,
  });

  /// Delay before attempt [attempt] (1-based).
  Duration delayFor(int attempt) {
    var grown = initialDelay.inMilliseconds.toDouble();
    for (var i = 1; i < attempt; i++) {
      grown = grown * (backoffFactor <= 1 ? 1 : backoffFactor);
    }
    final capped = grown.clamp(0.0, maxDelay.inMilliseconds.toDouble());
    return Duration(milliseconds: capped.toInt());
  }
}
