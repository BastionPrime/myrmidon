library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_push.dart';
import 'package:test/test.dart';

import 'mock_td_client.dart';

void main() {
  group('DeviceToken wire forms (schema)', () {
    test('FCM: token + encrypt, no extra keys', () {
      final form = tdFcmDeviceToken('fcm-token-value');
      expect(form['@type'], 'deviceTokenFirebaseCloudMessaging');
      expect(form['token'], 'fcm-token-value');
      expect(form['encrypt'], isFalse);
      expect(form.keys.toSet(), {'@type', 'token', 'encrypt'});
    });

    test('webPush: endpoint + p256dh + auth', () {
      final form = tdWebPushDeviceToken(
        endpoint: 'https://example/push',
        p256dhBase64url: 'key',
        authBase64url: 'auth',
      );
      expect(form['@type'], 'deviceTokenWebPush');
      expect(form.keys.toSet(),
          {'@type', 'endpoint', 'p256dh_base64url', 'auth_base64url'});
    });

    test('simplePush: endpoint only', () {
      final form = tdSimplePushDeviceToken('https://example/simple');
      expect(form['@type'], 'deviceTokenSimplePush');
      expect(form.keys.toSet(), {'@type', 'endpoint'});
    });
  });

  group('TdPush register/unregister', () {
    test('register sends registerDevice with token form and other_user_ids',
        () async {
      final mock = MockTdClient()..autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final push = TdPush(bridge: bridge);

      final token = TdPushToken(
        channelId: 'webpush',
        wireForm: () => tdWebPushDeviceToken(
          endpoint: 'https://example/push',
          p256dhBase64url: 'key',
          authBase64url: 'auth',
        ),
      );
      final receiver = await push.register(token, otherUserIds: [7, 9]);
      await Future<void>.delayed(Duration.zero);

      final request = mock.sentRequests.single;
      expect(request['@type'], 'registerDevice');
      expect(
        (request['device_token'] as Map)['@type'],
        'deviceTokenWebPush',
      );
      expect(request['other_user_ids'], [7, 9]);
      expect(receiver, isNull,
          reason: 'autoAnswer replies ok (no pushReceiverId id) → null');
    });

    test('register maps PushReceiverId id from the response', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final push = TdPush(bridge: bridge);
      final token = TdPushToken(
        channelId: 'x',
        wireForm: () => tdSimplePushDeviceToken('https://e'),
      );
      final call = push.register(token);
      mock.answerLast(const {'@type': 'pushReceiverId', 'id': 4242});
      final receiver = await call;
      expect(receiver?.id, '4242');
    });

    test('unregister: empty other_user_ids, token form passthrough',
        () async {
      final mock = MockTdClient()..autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final push = TdPush(bridge: bridge);
      final token = TdPushToken(
        channelId: 'fcm',
        wireForm: () => tdFcmDeviceToken(''),
      );
      await push.unregister(token);
      await Future<void>.delayed(Duration.zero);

      final request = mock.sentRequests.single;
      expect(request['@type'], 'registerDevice');
      expect(request['other_user_ids'], isEmpty);
      expect((request['device_token'] as Map)['token'], '',
          reason: 'empty token = documented deregistration semantics');
    });

    test('processPushNotification passes the opaque payload through',
        () async {
      final mock = MockTdClient()..autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final push = TdPush(bridge: bridge);
      await push.processPushNotification('opaque-payload-blob');
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests.single['@type'], 'processPushNotification');
      expect(mock.sentRequests.single['payload'], 'opaque-payload-blob');
    });
  });

  group('TdPushNoop (until ADR-0002)', () {
    test('no wire traffic at all; null receiver id', () async {
      final mock = MockTdClient();
      final noop = TdPushNoop();
      final token = TdPushToken(
        channelId: 'pending-adr-0002',
        wireForm: () => tdSimplePushDeviceToken('https://e'),
      );
      final receiver =
          await noop.register(token, otherUserIds: [1]);
      expect(receiver, isNull);
      await noop.unregister(token);
      await noop.processPushNotification('p');
      expect(mock.sentRequests, isEmpty);
    });
  });

  group('unified contract mapping', () {
    test('MessengerBackend.registerPush resolves to TdPushNoop today',
        () async {
      // messenger_backend.dart:60-62 — the unified contract allows a
      // no-op registerPush; for Network.telegram the wiring goes through
      // TdPushNoop until ADR-0002 decides the channel. TdPush itself is
      // the ready seam for whichever channel wins.
      final noop = TdPushNoop();
      expect(
        await noop.register(TdPushToken(
          channelId: 'c',
          wireForm: () => tdFcmDeviceToken('t'),
        )),
        isNull,
      );
    });
  });
}
