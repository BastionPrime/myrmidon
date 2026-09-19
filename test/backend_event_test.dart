import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  const max1 = AccountKey(network: Network.max, id: 1);
  const tg2 = AccountKey(network: Network.telegram, id: 2);

  test('message constructor fills message fields', () {
    final e = BackendEvent.message(
      account: max1,
      chatId: 'c:10',
      messageId: 'm:5',
      text: 'hello',
      senderId: 'u:3',
      timestamp: 1234,
    );
    expect(e.kind, BackendEventKind.newMessage);
    expect(e.account, max1);
    expect(e.chatId, 'c:10');
    expect(e.messageId, 'm:5');
    expect(e.text, 'hello');
    expect(e.timestamp, 1234);
  });

  test('events of different kinds are not equal', () {
    final a = BackendEvent(
      kind: BackendEventKind.newMessage,
      account: max1,
      timestamp: 1,
      chatId: 'c:1',
    );
    final b = BackendEvent(
      kind: BackendEventKind.messageDeleted,
      account: max1,
      timestamp: 1,
      chatId: 'c:1',
    );
    expect(a == b, isFalse);
  });

  test('equality covers all fields', () {
    final base = BackendEvent.message(
      account: tg2,
      chatId: 'c:10',
      messageId: 'm:5',
      text: 'hi',
      senderId: 'u:3',
      timestamp: 99,
    );
    final same = BackendEvent.message(
      account: tg2,
      chatId: 'c:10',
      messageId: 'm:5',
      text: 'hi',
      senderId: 'u:3',
      timestamp: 99,
    );
    expect(base == same, isTrue);
    expect(base.hashCode, same.hashCode);
  });

  test('event carries no transport-source field', () {
    final e = BackendEvent.message(
      account: max1,
      chatId: 'c:1',
      messageId: 'm:1',
      timestamp: 1,
    );
    expect(
      e.toString(),
      isNot(contains('fcm')),
    );
    expect(
      ['source', 'transport', 'fcm', 'webpush', 'socket']
          .any((f) => e.runtimeType.toString().toLowerCase().contains(f)),
      isFalse,
    );
  });

  test('all notification-relevant kinds are present', () {
    const kinds = BackendEventKind.values;
    expect(kinds, contains(BackendEventKind.newMessage));
    expect(kinds, contains(BackendEventKind.incomingCall));
    expect(kinds, contains(BackendEventKind.ghostModeChanged));
    expect(kinds, contains(BackendEventKind.connected));
    expect(kinds, contains(BackendEventKind.disconnected));
  });
}
