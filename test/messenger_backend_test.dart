import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/capabilities.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/models/unified/unified_chat.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

/// Compile-time contract check: a minimal implementation satisfies the
/// interface, and the interface surface matches plan-v3 4.3.
class _FakeBackend implements MessengerBackend {
  @override
  AccountKey get account => const AccountKey(network: Network.max, id: 1);

  @override
  Capabilities get capabilities => Capabilities.max;

  @override
  BackendState state = BackendState.disconnected;

  @override
  Stream<BackendEvent> get events => const Stream.empty();

  @override
  Stream<BackendState> get stateChanges => const Stream.empty();

  @override
  Future<List<UnifiedChat>> chats() async => const [];

  @override
  Future<List<UnifiedMessage>> history(String chatId, {int limit = 50}) async => const [];

  @override
  Future<SendResult> sendText(String chatId, String text) async =>
      SendResult(messageId: 'm:1', timestamp: 1);

  @override
  Future<void> sendMedia(String chatId, String filePath) async {}

  @override
  Future<void> editText(String chatId, String messageId, String newText) async {}

  @override
  Future<void> deleteMessages(String chatId, List<String> messageIds) async {}

  @override
  Future<void> setReaction(String chatId, String messageId, String reaction) async {}

  @override
  Future<void> markRead(String chatId) async {}

  @override
  Future<void> setTyping(String chatId, bool typing) async {}

  @override
  Future<void> downloadMedia(String messageId, String targetPath) async {}

  @override
  Future<void> registerPush(String pushToken) async {}

  @override
  Future<void> unregisterPush(String pushToken) async {}

  @override
  Future<void> setGhostMode(bool enabled) async {}

  @override
  Future<void> pause() async {
    state = BackendState.paused;
  }

  @override
  Future<void> resume() async {
    state = BackendState.connecting;
  }

  @override
  Future<void> dispose() async {}
}

void main() {
  test('a minimal implementation satisfies the backend contract', () {
    final backend = _FakeBackend();
    expect(backend.account.storageId, 'max:1');
    expect(backend.capabilities.sendText, isTrue);
    expect(backend.state, BackendState.disconnected);
  });

  test('pause/resume drive the state machine', () async {
    final backend = _FakeBackend();
    await backend.pause();
    expect(backend.state, BackendState.paused);
    await backend.resume();
    expect(backend.state, BackendState.connecting);
  });

  test('sendText returns a message identity', () async {
    final backend = _FakeBackend();
    final result = await backend.sendText('c:1', 'hi');
    expect(result.messageId, isNotEmpty);
    expect(result.timestamp, greaterThan(0));
  });

  test('history takes a chat id and limit', () async {
    final backend = _FakeBackend();
    expect(await backend.history('c:1'), isEmpty);
    expect(await backend.history('c:1', limit: 10), isEmpty);
  });
}
