import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/models/unified/unified_chat.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  const max1 = AccountKey(network: Network.max, id: 1);
  const tg2 = AccountKey(network: Network.telegram, id: 2);

  UnifiedChat chat({AccountKey account = max1, int unread = 0, int time = 100}) =>
      UnifiedChat(
        account: account,
        id: 'c:10',
        title: 'Chat',
        isGroup: false,
        lastEventTime: time,
        unreadCount: unread,
      );

  test('copyWith preserves identity fields', () {
    final c = chat().copyWith(title: 'Renamed', unreadCount: 4);
    expect(c.account, max1);
    expect(c.id, 'c:10');
    expect(c.title, 'Renamed');
    expect(c.unreadCount, 4);
  });

  test('newMessage event bumps preview, time and unread', () {
    final updated = applyEventToChat(
      chat(),
      BackendEvent.message(
        account: max1,
        chatId: 'c:10',
        messageId: 'm:1',
        text: 'new text',
        timestamp: 555,
      ),
    );
    expect(updated.unreadCount, 1);
    expect(updated.lastEventTime, 555);
    expect(updated.lastMessagePreview, 'new text');
  });

  test('chatRead event clears unread', () {
    final updated = applyEventToChat(
      chat(unread: 7),
      BackendEvent(
        kind: BackendEventKind.chatRead,
        account: max1,
        chatId: 'c:10',
        timestamp: 600,
      ),
    );
    expect(updated.unreadCount, 0);
  });

  test('events of other chats and accounts do not touch the chat', () {
    final untouched = applyEventToChat(
      chat(),
      BackendEvent.message(
        account: tg2,
        chatId: 'c:99',
        messageId: 'm:1',
        text: 'elsewhere',
        timestamp: 555,
      ),
    );
    expect(untouched.unreadCount, 0);
    expect(untouched.lastEventTime, 100);
    expect(untouched.lastMessagePreview, isNull);
  });

  test('empty text preview falls back to null', () {
    final updated = applyEventToChat(
      chat(),
      BackendEvent.message(
        account: max1,
        chatId: 'c:10',
        messageId: 'm:1',
        text: '',
        timestamp: 555,
      ),
    );
    expect(updated.lastMessagePreview, isNull);
    expect(updated.unreadCount, 1);
  });

  test('connection events leave the chat unchanged', () {
    final updated = applyEventToChat(
      chat(unread: 3, time: 100),
      BackendEvent(
        kind: BackendEventKind.connected,
        account: max1,
        timestamp: 999,
      ),
    );
    expect(updated.unreadCount, 3);
    expect(updated.lastEventTime, 100);
  });

  test('unified message copyWith keeps ids', () {
    const m = UnifiedMessage(
      account: max1,
      chatId: 'c:10',
      id: 'm:1',
      senderId: 'u:2',
      text: 'a',
      timestamp: 10,
    );
    final edited = m.copyWith(text: 'b', status: UnifiedMessageStatus.pending);
    expect(edited.id, 'm:1');
    expect(edited.chatId, 'c:10');
    expect(edited.text, 'b');
    expect(edited.status, UnifiedMessageStatus.pending);
    expect(edited.timestamp, 10);
  });
}
