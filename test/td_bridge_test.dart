library;

import 'dart:async';

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';

import 'mock_td_client.dart';

/// Captures log calls so tests can assert "content-free": only types,
/// codes and timings appear, never payloads.
class RecordingLog implements TdBridgeLog {
  final List<String> calls = [];

  @override
  void onSend(String method) => calls.add('send:$method');

  @override
  void onResult(String method, Duration elapsed) => calls.add('result:$method');

  @override
  void onTimeout(String method, Duration timeout) => calls.add('timeout:$method');

  @override
  void onErrorEvent(int code) => calls.add('errorEvent:$code');

  @override
  void onUpdate(String updateType) => calls.add('update:$updateType');

  @override
  void onReconnect(int attempt) => calls.add('reconnect:$attempt');

  @override
  void onDisposed() => calls.add('disposed');
}

void main() {
  group('TdBridge request/response by @extra', () {
    test('send attaches @extra, response resolves the future', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final future = bridge.send({'@type': 'getMe'});
      expect(bridge.pendingCount, 1);
      final extra = (mock.sentRequests.single['@extra'] as String);
      mock.answer(extra, {'@type': 'user', 'id': 7});
      final result = await future;
      expect(result['@type'], 'user');
      expect(bridge.pendingCount, 0);
      await bridge.destroy();
    });

    test('concurrent requests resolve to their own answers', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final f1 = bridge.send({'@type': 'getMe'});
      final f2 = bridge.send({'@type': 'loadChats'});
      final extras = mock.sentRequests.map((r) => r['@extra'] as String).toList();
      expect(extras.length, 2);
      expect(extras.toSet().length, 2, reason: 'extras must be unique');
      mock.answer(extras[1], {'@type': 'chats', 'chat_ids': [4]});
      mock.answer(extras[0], {'@type': 'user', 'id': 7});
      final me = await f1;
      final chats = await f2;
      expect(me['@type'], 'user');
      expect((chats['chat_ids'] as List).single, 4);
      await bridge.destroy();
    });

    test('error object fails the future as TdErrorException', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final future = bridge.send({'@type': 'getChat', 'chat_id': 5});
      final extra = mock.sentRequests.single['@extra'] as String;
      mock.answerError(extra, 400, 'CHAT_NOT_FOUND');
      await expectLater(
        future,
        throwsA(
          isA<TdErrorException>()
              .having((e) => e.code, 'code', 400)
              .having((e) => e.message, 'message', 'CHAT_NOT_FOUND'),
        ),
      );
      expect(bridge.pendingCount, 0);
      await bridge.destroy();
    });

    test('late answer for a timed-out request is ignored, not unhandled',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(
        client: mock,
        options: const TdBridgeOptions(
          requestTimeout: Duration(milliseconds: 30),
        ),
      );
      final future = bridge.send({'@type': 'getMe'});
      await expectLater(future, throwsA(isA<TdTimeoutException>()));
      // Late answer arrives after the timeout already dropped the extra:
      // must resolve silently, no unhandled async error.
      final extra = mock.sentRequests.single['@extra'] as String;
      mock.answer(extra, {'@type': 'user', 'id': 7});
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bridge.pendingCount, 0);
      await bridge.destroy();
    });
  });

  group('TdBridge timeouts', () {
    test('request exceeding the timeout completes with TdTimeoutException',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(
        client: mock,
        options: const TdBridgeOptions(
          requestTimeout: Duration(milliseconds: 25),
        ),
      );
      final future = bridge.send({'@type': 'getMe'});
      await expectLater(future, throwsA(isA<TdTimeoutException>()));
      expect(bridge.pendingCount, 0);
      await bridge.destroy();
    });
  });

  group('TdBridge update feed', () {
    test('key 4.4 updates stream through in order', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final received = <Map<String, dynamic>>[];
      final sub = bridge.updates.listen(received.add);
      mock.emitKeyUpdates();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(
        received.map((u) => u['@type']),
        containsAll(const [
          'updateAuthorizationState',
          'updateNewMessage',
          'updateChatLastMessage',
          'updateChatPosition',
          'updateChatReadInbox',
          'updateChatReadOutbox',
          'updateChatUnreadMentionCount',
          'updateUser',
          'updateChatTitle',
          'updateChatAction',
          'updateUserStatus',
          'updateFile',
          'updateConnectionState',
          'updateMessageContent',
          'updateDeleteMessages',
        ]),
      );
      expect(received.first['@type'], 'updateAuthorizationState');
      await sub.cancel();
      await bridge.destroy();
    });

    test('non-update unsolicited answers are not streamed as updates',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final received = <String>[];
      final sub = bridge.updates.listen((u) => received.add(u['@type'] as String));
      mock.emitUpdate({'@type': 'ok', '@extra': '999'});
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(received, isEmpty);
      await sub.cancel();
      await bridge.destroy();
    });
  });

  group('TdBridge reconnect policy', () {
    test('broken feed exhausts the budget and surfaces a failure', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(
        client: mock,
        options: const TdBridgeOptions(
          requestTimeout: Duration(seconds: 1),
          reconnectPolicy: TdReconnectPolicy(
            initialDelay: Duration(milliseconds: 5),
            maxDelay: Duration(milliseconds: 10),
            maxAttempts: 2,
          ),
        ),
      );
      final failures = <Object>[];
      final sub = bridge.failures.listen((f) {}, onError: failures.add);
      mock.feedBroken = true;
      mock.emitUpdate({'@type': 'updateOption'});
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(failures, isNotEmpty);
      await sub.cancel();
      await bridge.destroy();
    });
  });

  group('TdBridge content-free logging', () {
    test('log receives types/codes only, never payloads', () async {
      final mock = MockTdClient();
      final log = RecordingLog();
      final bridge = TdBridge(client: mock, log: log);
      final future = bridge.send({'@type': 'getChat', 'chat_id': 5});
      final extra = mock.sentRequests.single['@extra'] as String;
      mock.answerError(extra, 400, 'CHAT_NOT_FOUND');
      await expectLater(future, throwsA(isA<TdErrorException>()));
      mock.emitUpdate({'@type': 'updateNewMessage', 'message': {'chat_id': 1}});
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final joined = log.calls.join('|');
      expect(joined, contains('send:getChat'));
      expect(joined, contains('result:getChat'));
      expect(joined, contains('errorEvent:400'));
      expect(joined, contains('update:updateNewMessage'));
      // Content must never appear in any log line.
      expect(joined, isNot(contains('chat_id')));
      expect(joined, isNot(contains('message')));
      expect(joined, isNot(contains('CHAT_NOT_FOUND')));
      await bridge.destroy();
      expect(log.calls, contains('disposed'));
    });
  });

  group('TdBridge lifecycle', () {
    test('send after destroy throws StateError', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      await bridge.destroy();
      expect(() => bridge.send({'@type': 'getMe'}), throwsStateError);
      expect(bridge.isDestroyed, isTrue);
    });

    test('destroy fails in-flight requests', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final future = bridge.send({'@type': 'getMe'});
      // Listener attached before destroy: the error of an in-flight
      // request must be consumed by its awaiting caller, not escape as an
      // unhandled zone error.
      final probe = expectLater(future, throwsA(isA<StateError>()));
      await bridge.destroy();
      await probe;
    });

    test('execute passthrough for sync requests', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final result = bridge.execute({'@type': 'setLogVerbosityLevel', 'new_verbosity_level': 1});
      expect(result?.type, 'ok');
      expect(mock.executeRequests.single['@type'], 'setLogVerbosityLevel');
      await bridge.destroy();
    });

    test('applyParameters sends setTdlibParameters with config fields',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final future = bridge.applyParameters(
        TdClientConfig(
          databaseDirectory: '/data/tg/1/tdlib',
          filesDirectory: '/data/tg/1/files',
          databaseEncryptionKey: List<int>.filled(32, 7),
          apiId: 12345,
          apiHash: 'deadbeef',
          systemLanguageCode: 'ru',
          deviceModel: 'Device',
          systemVersion: '16',
          applicationVersion: '0.0.1',
        ),
      );
      final request = mock.sentRequests.single;
      expect(request['@type'], 'setTdlibParameters');
      expect(request['database_directory'], '/data/tg/1/tdlib');
      expect(request['files_directory'], '/data/tg/1/files');
      expect(request['api_id'], 12345);
      expect(request['use_secret_chats'], false);
      expect(request['use_message_database'], true);
      mock.answer(request['@extra'] as String, {'@type': 'ok'});
      expect((await future)['@type'], 'ok');
      await bridge.destroy();
    });
  });

  group('TdReconnectPolicy', () {
    test('delays grow exponentially and cap at maxDelay', () {
      const policy = TdReconnectPolicy(
        initialDelay: Duration(milliseconds: 100),
        maxDelay: Duration(milliseconds: 800),
        maxAttempts: 6,
      );
      expect(policy.delayFor(1), const Duration(milliseconds: 100));
      expect(policy.delayFor(2), const Duration(milliseconds: 200));
      expect(policy.delayFor(3), const Duration(milliseconds: 400));
      expect(policy.delayFor(4), const Duration(milliseconds: 800));
      expect(policy.delayFor(5), const Duration(milliseconds: 800));
    });

    test('backoffFactor <= 1 keeps the delay constant', () {
      const policy = TdReconnectPolicy(
        initialDelay: Duration(milliseconds: 50),
        maxDelay: Duration(seconds: 10),
        maxAttempts: 3,
        backoffFactor: 0.5,
      );
      expect(policy.delayFor(1), const Duration(milliseconds: 50));
      expect(policy.delayFor(3), const Duration(milliseconds: 50));
    });
  });

  group('TdResponse', () {
    test('extra and type parse from wire json', () {
      final r = TdResponse({'@type': 'user', 'id': 3, '@extra': '42'});
      expect(r.extra, '42');
      expect(r.type, 'user');
      final bare = TdResponse({'@type': 7});
      expect(bare.extra, isNull);
      expect(bare.type, '');
    });
  });
}
