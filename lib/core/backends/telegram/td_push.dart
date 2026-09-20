/// Push registration seam for the Telegram backend (plan-v3 Т-2.10).
///
/// Strategy is governed by ADR-0002 (push-стратегия по E1/E2/E4/E7) — NOT
/// written yet, so this module deliberately binds to NO delivery channel:
/// the owner's decision п.2.5 stands (code where FCM is the only delivery
/// path is blocked at review). What ships now:
/// - [TdPushToken] — an opaque token + a builder for its DeviceToken wire
///   form; the channel choice (FCM / webpush / simplepush / …) is ADR-0002
///   territory and is injected by the caller, never hardcoded here.
/// - [TdPush.register] — `registerDevice device_token:DeviceToken
///   other_user_ids:vector<int53> = PushReceiverId` (td_api.tl:15602):
///   every live TG client registers the SAME token listing the other
///   accounts' user ids (мультиаккаунт-семантика плана 4.4 «общий токен
///   регистрируется каждым клиентом с other_user_ids»).
/// - [TdPush.unregister] — registerDevice with an empty token field
///   (deregistration semantics of the DeviceToken constructors: «may be
///   empty to deregister a device»).
/// - [TdPush.processPushNotification] — `processPushNotification
///   payload:string = Ok` (td_api.tl:15606) passthrough for the `google`
///   flavor routing; the payload body is opaque to the app and is never
///   logged or parsed here.
///
/// Wire shapes follow the master td_api.tl schema, verified by
/// tools/td_schema_check.py: registerDevice:15602, processPushNotification
/// :15606, deviceTokenFirebaseCloudMessaging:8389 (token:string
/// encrypt:Bool), deviceTokenWebPush:8410 (endpoint p256dh_base64url
/// auth_base64url), deviceTokenSimplePush:8412 (endpoint:string).
library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';

/// A push token whose wire form is a DeviceToken constructor map.
/// The channel (FCM, webpush, simplepush, …) is chosen by the caller per
/// ADR-0002 — this seam stays channel-agnostic.
typedef TdDeviceTokenBuilder = Map<String, dynamic> Function();

class TdPushToken {
  /// Unique id of this subscription channel (for bookkeeping only).
  final String channelId;

  /// Builds the DeviceToken constructor map (e.g. deviceTokenWebPush).
  final TdDeviceTokenBuilder wireForm;

  const TdPushToken({required this.channelId, required this.wireForm});
}

/// Well-known channel builders (schema-verified shapes; picking WHICH of
/// them ships is ADR-0002's decision, not this module's).
Map<String, dynamic> tdFcmDeviceToken(String token, {bool encrypt = false}) => {
      '@type': 'deviceTokenFirebaseCloudMessaging',
      'token': token,
      'encrypt': encrypt,
    };

Map<String, dynamic> tdWebPushDeviceToken({
  required String endpoint,
  required String p256dhBase64url,
  required String authBase64url,
}) =>
    {
      '@type': 'deviceTokenWebPush',
      'endpoint': endpoint,
      'p256dh_base64url': p256dhBase64url,
      'auth_base64url': authBase64url,
    };

Map<String, dynamic> tdSimplePushDeviceToken(String endpoint) => {
      '@type': 'deviceTokenSimplePush',
      'endpoint': endpoint,
    };

/// Result of a registerDevice call: the PushReceiverId of the subscription.
class TdPushReceiverId {
  /// Globally unique identifier of the push subscription (int64 as String).
  final String id;

  const TdPushReceiverId(this.id);
}

class TdPush {
  final TdBridge bridge;

  TdPush({required this.bridge});

  /// Registers the device token through this client's session.
  /// [otherUserIds] lists the user ids of the OTHER live accounts so the
  /// shared token fans notifications out to every logged-in account
  /// (plan 4.4 multi-account semantics; each client registers the same
  /// token with its own other_user_ids view).
  Future<TdPushReceiverId?> register(
    TdPushToken token, {
    List<int> otherUserIds = const [],
  }) async {
    final response = await bridge.send({
      '@type': 'registerDevice',
      'device_token': token.wireForm(),
      'other_user_ids': otherUserIds,
    });
    final id = response['id'];
    return id is int ? TdPushReceiverId('$id') : null;
  }

  /// Deregisters the device: registerDevice with an EMPTY token field —
  /// the DeviceToken constructors' documented deregistration semantics
  /// («may be empty to deregister a device»); the receiver id is not
  /// reusable afterwards.
  Future<void> unregister(TdPushToken token) => bridge.send({
        '@type': 'registerDevice',
        'device_token': token.wireForm(),
        'other_user_ids': const [],
      });

  /// Passes a received push payload to TDLib (google-flavor routing,
  /// Т-2.10 плана: «обработка processPushNotification в google»).
  /// The payload is opaque — never parsed, never logged.
  Future<void> processPushNotification(String payload) => bridge.send({
        '@type': 'processPushNotification',
        'payload': payload,
      });
}

/// No-op registrar until ADR-0002 lands: the delivery channel decision is
/// pending, so the TelegramBackend exposes a seam that registers nothing
/// and returns no receiver id. This is the wiring the unified
/// MessengerBackend.registerPush contract resolves to for Network.telegram
/// today («регистрация — no-op/шов до ADR-0002», задача Т-2.10).
class TdPushNoop {
  Future<TdPushReceiverId?> register(
    TdPushToken token, {
    List<int> otherUserIds = const [],
  }) async => null;

  Future<void> unregister(TdPushToken token) async {}

  Future<void> processPushNotification(String payload) async {}
}
