import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_backend.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/backends/capabilities.dart' show Capabilities;
import 'package:test/test.dart';

import 'fake_max_api.dart';
import 'in_memory_secure_storage.dart';

const account = AccountKey(network: Network.max, id: 7);

CredentialStore credentialStoreWith(String token) {
  final storage = InMemorySecureStorage();
  return CredentialStore(storage)..saveToken(account, token);
}

SessionSpecBuilder specBuilder() => SessionSpecBuilder(
      loadSpoofProfile: (a) async => {
        'deviceId': 'spoof-device',
        'appVersion': '26.23.2',
        'buildNumber': 6779,
      },
      loadEndpoint: () async => (host: 'api2.oneme.ru', port: 443),
      loadProxyUrl: () async => null,
    );

void main() {
  late FakeMaxApi api;
  late MaxBackend backend;

  setUp(() {
    api = FakeMaxApi();
    backend = MaxBackend(
      account: account,
      api: api,
      credentials: credentialStoreWith('token-7'),
      specBuilder: specBuilder(),
    );
  });

  tearDown(() async {
    await backend.dispose();
  });

  test('connectAndLogin builds SessionSpec and logs in with the credential',
      () async {
    await backend.connectAndLogin();
    expect(api.lastSpec, isNotNull);
    expect(api.lastSpec!.host, 'api2.oneme.ru');
    expect(api.lastSpec!.deviceId, 'spoof-device');
    expect(api.lastLoginToken, 'token-7');
    expect(backend.state, BackendState.online);
  });

  test('connectAndLogin without credential fails loudly', () async {
    final bare = MaxBackend(
      account: account,
      api: api,
      credentials: CredentialStore(InMemorySecureStorage()),
      specBuilder: specBuilder(),
    );
    expect(bare.connectAndLogin(), throwsStateError);
    await bare.dispose();
  });

  test('chats maps through the unified mapper', () async {
    api.chats = const [
      MaxCachedChat(
        id: 10,
        type: 'GROUP',
        title: 'Группа',
        unreadCount: 2,
        lastEventTime: 5,
      ),
    ];
    final chats = await backend.chats();
    expect(chats, hasLength(1));
    expect(chats.first.id, 'c:10');
    expect(chats.first.isGroup, isTrue);
    expect(chats.first.unreadCount, 2);
  });

  test('history returns oldest-first unified messages', () async {
    api.history = const [
      MaxCachedMessage(id: '2', chatId: 10, senderId: 1, text: 'b', time: 200),
      MaxCachedMessage(id: '1', chatId: 10, senderId: 1, text: 'a', time: 100),
    ];
    final messages = await backend.history('c:10');
    expect(messages.map((m) => m.id).toList(), ['1', '2']);
    expect(messages.first.text, 'a');
  });

  test('sendText returns the server message id', () async {
    api.nextMessageId = '555';
    final result = await backend.sendText('c:10', 'привет');
    expect(result.messageId, '555');
    expect(api.sentTexts, ['привет']);
    expect(result.timestamp, greaterThan(0));
  });

  test('chatId parsing rejects non-MAX identifiers', () async {
    expect(backend.sendText('tg:10', 'x'), throwsFormatException);
    expect(backend.sendText('c:abc', 'x'), throwsFormatException);
  });

  test('markRead marks the latest message', () async {
    api.history = const [
      MaxCachedMessage(id: '42', chatId: 10, senderId: 1, text: 'x', time: 1),
    ];
    await backend.markRead('c:10');
    expect(api.markedRead, ['10/42']);
  });

  test('setTyping delegates to the api', () async {
    await backend.setTyping('c:10', true);
    expect(api.sentTyping, [(10, 'TEXT')]);
  });

  test('registerPush delegates to the privacy seam', () async {
    await backend.registerPush('fcm-token-1');
    expect(api.lastPushToken, 'fcm-token-1');
    await backend.unregisterPush('fcm-token-1');
    expect(api.lastPushToken, isNull);
  });

  test('setGhostMode flips the upstream invisible mode and emits an event',
      () async {
    final events = <BackendEvent>[];
    final sub = backend.events.listen(events.add);
    await backend.setGhostMode(true);
    await Future<void>.delayed(Duration.zero);
    expect(api.lastGhostMode, isTrue);
    expect(backend.isGhostMode, isTrue);
    expect(
      events.map((e) => e.kind),
      contains(BackendEventKind.ghostModeChanged),
    );
    await sub.cancel();
  });

  test('push packets surface as unified events', () async {
    final events = <BackendEvent>[];
    final sub = backend.events.listen(events.add);
    api.emitPush(
      const MaxPushPacket(
        opcode: MaxOpcode.notifMessage,
        payload: {
          'chatId': 10,
          'message': {'id': 9, 'sender': 3, 'text': 'пуш', 'time': 12},
        },
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(events, hasLength(1));
    expect(events.first.kind, BackendEventKind.newMessage);
    expect(events.first.chatId, 'c:10');
    expect(events.first.text, 'пуш');
    await sub.cancel();
  });

  test('api state changes propagate to unified state stream', () async {
    final states = <BackendState>[];
    final sub = backend.stateChanges.listen(states.add);
    await backend.connectAndLogin();
    await Future<void>.delayed(Duration.zero);
    expect(states, contains(BackendState.online));
    await sub.cancel();
  });

  test('pause disconnects, resume reconnects and re-logins', () async {
    await backend.connectAndLogin();
    await backend.pause();
    expect(api.disconnected, isTrue);
    expect(backend.state, BackendState.paused);

    api.disconnected = false;
    await backend.resume();
    expect(backend.state, BackendState.online);
    expect(api.lastLoginToken, 'token-7');
  });

  test('capabilities are MAX presets', () {
    expect(backend.capabilities, same(Capabilities.max));
  });

  test('dispose closes streams exactly once', () async {
    await backend.dispose();
    expect(api.disposed, isTrue);
    await backend.dispose();
    expect(api.disposeCount, 1);
  });
}

