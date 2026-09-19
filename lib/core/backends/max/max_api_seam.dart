/// Seams over the upstream Komet/kolibri stack (plan-v3 T-1.4).
///
/// MaxBackend wraps the existing Api/AccountModule/MessagesModule/ChatsModule
/// and builds sessions through kolibri SessionOptions. Upstream types are not
/// importable in a pure-Dart workspace (Flutter plugins), so the adapter talks
/// to narrow seams defined here; production wires real implementations in
/// main, tests inject fakes.
library;

import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';

/// Raw MAX packet as delivered by the kolibri push stream (opcode + JSON map).
class MaxPushPacket {
  final int opcode;
  final Map<String, dynamic> payload;

  const MaxPushPacket({required this.opcode, required this.payload});

  Map<String, dynamic> get message =>
      payload['message'] is Map
          ? (payload['message'] as Map).cast<String, dynamic>()
          : const {};
}

Map<String, dynamic> asMaxMap(Object? raw) =>
    raw is Map ? raw.cast<String, dynamic>() : const {};

/// MAX protocol opcodes needed by MaxBackend (opcode_map.dart).
abstract final class MaxOpcode {
  static const int notifMessage = 128;
  static const int msgTyping = 65;
  static const int msgEdit = 67;
  static const int msgDelete = 66;
  static const int msgReaction = 178;
  static const int msgCancelReaction = 179;
  static const int config = 22;
}

/// Connection state mirroring upstream `SessionState` (subset).
enum MaxSessionState { disconnected, connecting, online, reconnecting }

/// View of one cached MAX chat (subset of upstream CachedChat).
class MaxCachedChat {
  final int id;
  final String type;
  final String? title;
  final String? iconUrl;
  final int unreadCount;
  final int lastEventTime;
  final String? lastMsgText;
  final int? lastMsgSenderId;

  const MaxCachedChat({
    required this.id,
    required this.type,
    this.title,
    this.iconUrl,
    required this.unreadCount,
    required this.lastEventTime,
    this.lastMsgText,
    this.lastMsgSenderId,
  });

  bool get isGroup => type == 'GROUP' || type == 'CHANNEL';
}

/// View of one cached MAX message (subset of upstream CachedMessage).
class MaxCachedMessage {
  final String id;
  final int chatId;
  final int senderId;
  final String? text;
  final int time;

  const MaxCachedMessage({
    required this.id,
    required this.chatId,
    required this.senderId,
    this.text,
    required this.time,
  });
}

/// The seam over upstream Api + AccountModule/MessagesModule/ChatsModule that
/// MaxBackend drives. Method shapes follow upstream signatures (modules take
/// accountId/chatId explicitly; message ids are strings).
abstract class MaxApiLike {
  Future<void> connect({required SessionSpec spec});
  Future<void> disconnect();
  Future<void> dispose();

  MaxSessionState get state;
  Stream<MaxSessionState> get stateStream;
  Stream<MaxPushPacket> get pushStream;

  Future<void> login({required String token});
  Future<void> registerPushToken(String pushToken);
  Future<void> unregisterPushToken(String pushToken);

  Future<void> setGhostMode(bool enabled);

  Future<List<MaxCachedChat>> getChats();
  Future<List<MaxCachedMessage>> fetchHistory(
    int chatId, {
    int count,
    int? backward,
  });
  Future<String> sendMessage(int chatId, String text);
  Future<bool> editMessage(int chatId, String messageId, String text);
  Future<bool> deleteMessages(int chatId, List<String> messageIds);
  Future<bool> setReaction(int chatId, String messageId, String emoji);
  Future<void> markRead(int chatId, String messageId);
  Future<void> sendTyping(int chatId, bool typing);
}

/// Parameters of the kolibri session assembled from the spoof profile and
/// config (plan-v3 4.2): device fields from the spoof profile, host/port from
/// config or server_host_override, proxy URL from ProxySettings.
class SessionSpec {
  final String host;
  final int port;
  final String deviceId;
  final String instanceId;
  final String appVersion;
  final int buildNumber;
  final String deviceType;
  final String osVersion;
  final String timezone;
  final String screen;
  final String pushDeviceType;
  final String arch;
  final String locale;
  final String deviceName;
  final String deviceLocale;
  final int clientSessionId;
  final int pingIntervalSecs;
  final bool pingInteractive;
  final bool autoReconnect;
  final bool insecureTls;
  final String? proxy;

  const SessionSpec({
    required this.host,
    required this.port,
    required this.deviceId,
    required this.instanceId,
    required this.appVersion,
    required this.buildNumber,
    required this.deviceType,
    required this.osVersion,
    required this.timezone,
    required this.screen,
    required this.pushDeviceType,
    required this.arch,
    required this.locale,
    required this.deviceName,
    required this.deviceLocale,
    required this.clientSessionId,
    this.pingIntervalSecs = 30,
    required this.pingInteractive,
    this.autoReconnect = false,
    this.insecureTls = false,
    this.proxy,
  });

  static const String defaultHost = 'api2.oneme.ru';
  static const int defaultPort = 443;

  factory SessionSpec.fromMap(Map<String, dynamic> map) => SessionSpec(
        host: map['host'] as String? ?? defaultHost,
        port: map['port'] as int? ?? defaultPort,
        deviceId: map['deviceId'] as String? ?? '',
        instanceId: map['instanceId'] as String? ?? '',
        appVersion: map['appVersion'] as String? ?? '',
        buildNumber: map['buildNumber'] as int? ?? 0,
        deviceType: map['deviceType'] as String? ?? 'ANDROID',
        osVersion: map['osVersion'] as String? ?? '',
        timezone: map['timezone'] as String? ?? '',
        screen: map['screen'] as String? ?? '',
        pushDeviceType: map['pushDeviceType'] as String? ?? 'GCM',
        arch: map['arch'] as String? ?? 'arm64-v8a',
        locale: map['locale'] as String? ?? 'ru',
        deviceName: map['deviceName'] as String? ?? '',
        deviceLocale: map['deviceLocale'] as String? ?? 'ru',
        clientSessionId: map['clientSessionId'] as int? ?? 0,
        pingIntervalSecs: map['pingIntervalSecs'] as int? ?? 30,
        pingInteractive: map['pingInteractive'] as bool? ?? true,
        autoReconnect: map['autoReconnect'] as bool? ?? false,
        insecureTls: map['insecureTls'] as bool? ?? false,
        proxy: map['proxy'] as String?,
      );

  /// Exactly the kolibri SessionOptions field set (a6cdce9): host, port,
  /// deviceId, instanceId, appVersion, buildNumber, deviceType, osVersion,
  /// timezone, screen, pushDeviceType, arch, locale, deviceName, deviceLocale,
  /// clientSessionId, pingIntervalSecs, pingInteractive, autoReconnect,
  /// insecureTls, proxy.
  Map<String, dynamic> toSessionOptionsMap() => {
        'host': host,
        'port': port,
        'deviceId': deviceId,
        'instanceId': instanceId,
        'appVersion': appVersion,
        'buildNumber': buildNumber,
        'deviceType': deviceType,
        'osVersion': osVersion,
        'timezone': timezone,
        'screen': screen,
        'pushDeviceType': pushDeviceType,
        'arch': arch,
        'locale': locale,
        'deviceName': deviceName,
        'deviceLocale': deviceLocale,
        'clientSessionId': clientSessionId,
        'pingIntervalSecs': pingIntervalSecs,
        'pingInteractive': pingInteractive,
        'autoReconnect': autoReconnect,
        'insecureTls': insecureTls,
        'proxy': proxy,
      };
}

/// Builds [SessionSpec] for an account from the spoof profile + config +
/// proxy settings (upstream api.dart assembles this inline; plan-v3 T-1.4
/// makes it explicit and testable).
class SessionSpecBuilder {
  final Future<Map<String, dynamic>?> Function(AccountKey account)
      loadSpoofProfile;
  final Future<({String host, int port})> Function() loadEndpoint;
  final Future<String?> Function() loadProxyUrl;

  const SessionSpecBuilder({
    required this.loadSpoofProfile,
    required this.loadEndpoint,
    required this.loadProxyUrl,
  });

  Future<SessionSpec> build(AccountKey account) async {
    final endpoint = await loadEndpoint();
    final spoof = await loadSpoofProfile(account) ?? const {};
    final proxy = await loadProxyUrl();
    return SessionSpec.fromMap({
      ...spoof,
      'host': endpoint.host,
      'port': endpoint.port,
      'proxy': proxy,
      'pingInteractive': true,
      'autoReconnect': false,
    });
  }
}
