import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_mappers.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart' show BackendState;
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  const account = AccountKey(network: Network.max, id: 7);

  test('chat id is stringified with c: prefix', () {
    expect(maxChatId(123), 'c:123');
  });

  test('mapChat fills title fallback and group flag', () {
    final group = mapChat(
      account,
      const MaxCachedChat(
        id: 10,
        type: 'GROUP',
        title: null,
        iconUrl: 'http://avatar',
        unreadCount: 3,
        lastEventTime: 555,
        lastMsgText: 'привет',
        lastMsgSenderId: 2,
      ),
    );
    expect(group.id, 'c:10');
    expect(group.title, 'Чат 10');
    expect(group.isGroup, isTrue);
    expect(group.unreadCount, 3);
    expect(group.lastMessagePreview, 'привет');
    expect(group.account, account);

    final dialog = mapChat(
      account,
      const MaxCachedChat(
        id: 11,
        type: 'DIALOG',
        title: 'Личное',
        unreadCount: 0,
        lastEventTime: 1,
      ),
    );
    expect(dialog.isGroup, isFalse);
    expect(dialog.title, 'Личное');
  });

  test('mapMessage produces unified identity fields', () {
    final m = mapMessage(
      account,
      const MaxCachedMessage(
        id: '42',
        chatId: 10,
        senderId: 5,
        text: 'текст',
        time: 777,
      ),
    );
    expect(m.id, '42');
    expect(m.chatId, 'c:10');
    expect(m.senderId, 'u:5');
    expect(m.text, 'текст');
    expect(m.timestamp, 777);
    expect(m.account, account);
  });

  test('mapState mirrors upstream states', () {
    expect(mapState(MaxSessionState.online), BackendState.online);
    expect(mapState(MaxSessionState.connecting), BackendState.connecting);
    expect(mapState(MaxSessionState.reconnecting), BackendState.connecting);
    expect(mapState(MaxSessionState.disconnected), BackendState.disconnected);
  });

  test('mapPush converts notifMessage into newMessage event', () {
    final event = mapPush(
      account,
      MaxPushPacket(
        opcode: MaxOpcode.notifMessage,
        payload: {
          'chatId': 10,
          'message': {
            'id': 42,
            'sender': 5,
            'text': 'новое',
            'time': 900,
          },
        },
      ),
    );
    expect(event, isNotNull);
    expect(event!.kind, BackendEventKind.newMessage);
    expect(event.chatId, 'c:10');
    expect(event.messageId, '42');
    expect(event.text, 'новое');
    expect(event.senderId, 'u:5');
    expect(event.timestamp, 900);
    expect(event.account, account);
  });

  test('mapPush drops comment-style and malformed pushes', () {
    expect(
      mapPush(
        account,
        const MaxPushPacket(
          opcode: MaxOpcode.notifMessage,
          payload: {
            'chatId': 10,
            'postId': 'abc',
            'message': {'id': 1, 'time': 1},
          },
        ),
      ),
      isNotNull,
    );
    expect(
      mapPush(
        account,
        const MaxPushPacket(opcode: MaxOpcode.notifMessage, payload: {}),
      ),
      isNull,
    );
    expect(
      mapPush(
        account,
        const MaxPushPacket(
          opcode: MaxOpcode.notifMessage,
          payload: {
            'message': {'id': 1},
          },
        ),
      ),
      isNull,
    );
  });

  test('mapPush converts typing packet into typing event', () {
    final event = mapPush(
      account,
      const MaxPushPacket(
        opcode: MaxOpcode.msgTyping,
        payload: {'chatId': 10, 'userId': 5},
      ),
    );
    expect(event, isNotNull);
    expect(event!.kind, BackendEventKind.typing);
    expect(event.chatId, 'c:10');
    expect(event.senderId, 'u:5');
  });

  test('mapPush ignores unrelated opcodes', () {
    expect(
      mapPush(
        account,
        const MaxPushPacket(opcode: 999, payload: {'chatId': 1}),
      ),
      isNull,
    );
  });

  group('SessionSpec', () {
    test('fromMap applies defaults', () {
      final spec = SessionSpec.fromMap({});
      expect(spec.host, SessionSpec.defaultHost);
      expect(spec.port, SessionSpec.defaultPort);
      expect(spec.deviceType, 'ANDROID');
      expect(spec.arch, 'arm64-v8a');
      expect(spec.pingInteractive, isTrue);
    });

    test('toSessionOptionsMap carries the full kolibri field set', () {
      const spec = SessionSpec(
        host: 'api2.oneme.ru',
        port: 443,
        deviceId: 'd1',
        instanceId: 'i1',
        appVersion: '26.23.2',
        buildNumber: 6779,
        deviceType: 'ANDROID',
        osVersion: 'Android 14',
        timezone: 'Europe/Moscow',
        screen: 'xxhdpi 450dpi 1440x3120',
        pushDeviceType: 'GCM',
        arch: 'arm64-v8a',
        locale: 'ru',
        deviceName: 'Pixel 8',
        deviceLocale: 'ru',
        clientSessionId: 123,
        pingInteractive: false,
        autoReconnect: true,
        insecureTls: false,
        proxy: 'socks5://127.0.0.1:1080',
      );
      final map = spec.toSessionOptionsMap();
      expect(map.keys, containsAll(<String>[
        'host', 'port', 'deviceId', 'instanceId', 'appVersion', 'buildNumber',
        'deviceType', 'osVersion', 'timezone', 'screen', 'pushDeviceType',
        'arch', 'locale', 'deviceName', 'deviceLocale', 'clientSessionId',
        'pingIntervalSecs', 'pingInteractive', 'autoReconnect', 'insecureTls',
        'proxy',
      ]));
      expect(map.length, 21);
      expect(map['appVersion'], '26.23.2');
      expect(map['buildNumber'], 6779);
      expect(map['proxy'], 'socks5://127.0.0.1:1080');
    });

    test('builder merges spoof profile with endpoint and proxy', () async {
      final builder = SessionSpecBuilder(
        loadSpoofProfile: (a) async => {
          'deviceId': 'spoof-device',
          'deviceName': 'Samsung Galaxy S24 Ultra',
          'osVersion': 'Android 14',
          'timezone': 'Europe/Berlin',
          'locale': 'de',
          'clientSessionId': 77,
          'appVersion': '26.23.2',
          'buildNumber': 6779,
        },
        loadEndpoint: () async => (host: 'api2.oneme.ru', port: 443),
        loadProxyUrl: () async => 'socks5h://user:pass@10.0.0.1:1080',
      );
      final spec = await builder.build(account);
      expect(spec.host, 'api2.oneme.ru');
      expect(spec.port, 443);
      expect(spec.deviceId, 'spoof-device');
      expect(spec.deviceName, 'Samsung Galaxy S24 Ultra');
      expect(spec.locale, 'de');
      expect(spec.clientSessionId, 77);
      expect(spec.appVersion, '26.23.2');
      expect(spec.buildNumber, 6779);
      expect(spec.proxy, 'socks5h://user:pass@10.0.0.1:1080');
      expect(spec.pingInteractive, isTrue);
      expect(spec.autoReconnect, isFalse);
    });

    test('builder survives absent spoof profile', () async {
      final builder = SessionSpecBuilder(
        loadSpoofProfile: (a) async => null,
        loadEndpoint: () async => (host: 'api2.oneme.ru', port: 443),
        loadProxyUrl: () async => null,
      );
      final spec = await builder.build(account);
      expect(spec.host, 'api2.oneme.ru');
      expect(spec.deviceId, isEmpty);
      expect(spec.proxy, isNull);
    });
  });
}
