library;

import 'package:test/test.dart';
import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_chat_store.dart';
import 'package:wellmagram/core/models/unified/unified_chat.dart';

import 'mock_td_client.dart';

const account = AccountKey(network: Network.telegram, id: 1);

Map<String, dynamic> chatJson({
  required int id,
  String type = 'chatTypePrivate',
  String title = 'Peer',
  int unread = 0,
  Map<String, dynamic>? lastMessage,
}) =>
    {
      '@type': 'chat',
      'id': id,
      'type': {'@type': type, if (type == 'chatTypeSupergroup') 'is_channel': true},
      'title': title,
      'unread_count': unread,
      'last_read_inbox_message_id': 0,
      'last_read_outbox_message_id': 0,
      'unread_mention_count': 0,
      'positions': const [],
      if (lastMessage != null) 'last_message': lastMessage,
    };

Map<String, dynamic> messageJson({
  required int id,
  required int chatId,
  String text = 'hi',
  int date = 1758381000,
  bool outgoing = false,
  int senderUserId = 7717,
}) =>
    {
      '@type': 'message',
      'id': id,
      'chat_id': chatId,
      'sender_id': {'@type': 'messageSenderUser', 'user_id': senderUserId},
      'content': {
        '@type': 'messageText',
        'text': {'@type': 'formattedText', 'text': text},
      },
      'date': date,
      'is_outgoing': outgoing,
    };

void main() {
  group('TG→Unified mappers', () {
    test('private chat maps with t:<id>, title, unread, preview', () {
      final chat = mapTgChat(
        account,
        chatJson(
          id: 101,
          title: 'Ab',
          unread: 3,
          lastMessage: messageJson(id: 531, chatId: 101, text: 'last'),
        ),
      );
      expect(chat.id, 't:101');
      expect(chat.title, 'Ab');
      expect(chat.isGroup, isFalse);
      expect(chat.unreadCount, 3);
      expect(chat.lastMessagePreview, 'last');
      expect(chat.lastEventTime, 1758381000000);
    });

    test('basicGroup/supergroup/secret are groups, private is not', () {
      for (final type in ['chatTypeBasicGroup', 'chatTypeSupergroup', 'chatTypeSecret']) {
        expect(tgChatIsGroup(chatJson(id: 1, type: type)), isTrue, reason: type);
      }
      expect(tgChatIsGroup(chatJson(id: 1)), isFalse);
    });

    test('empty title falls back to «Чат <id>»', () {
      expect(tgChatTitle(chatJson(id: 47, title: '')), 'Чат 47');
    });

    test('message maps: id/chat/sender/text/date/status', () {
      final m = mapTgMessage(account, messageJson(id: 531, chatId: 101));
      expect(m.id, '531');
      expect(m.chatId, 't:101');
      expect(m.senderId, 'u:7717');
      expect(m.text, 'hi');
      expect(m.timestamp, 1758381000000);
      expect(m.status, UnifiedMessageStatus.delivered);

      final out = mapTgMessage(
        account,
        messageJson(id: 532, chatId: 101, outgoing: true),
      );
      expect(out.status, UnifiedMessageStatus.sent);
    });

    test('sender variants: user, chat, unknown shape', () {
      expect(
        tgSenderId({'@type': 'messageSenderUser', 'user_id': 9}),
        'u:9',
      );
      expect(
        tgSenderId({'@type': 'messageSenderChat', 'chat_id': 11}),
        't:11',
      );
      expect(tgSenderId({'@type': 'messageSenderFoo'}), isNull);
      expect(tgSenderId(null), isNull);
    });

    test('non-text content maps to empty text, not a crash', () {
      expect(tgContentText({'@type': 'messagePhoto'}), '');
      expect(tgContentText(null), '');
      expect(
        tgContentText({
          '@type': 'messageText',
          'text': {'@type': 'formattedText', 'text': 'ok'},
        }),
        'ok',
      );
    });

    test('chat without last_message: time 0, preview null', () {
      final chat = mapTgChat(account, chatJson(id: 5));
      expect(chat.lastEventTime, 0);
      expect(chat.lastMessagePreview, isNull);
    });
  });

  group('TdChatStore ingest + updates', () {
    test('ingest stores and exposes unified views', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      final view = store.ingest(chatJson(id: 101, title: 'One'));
      expect(view.title, 'One');
      expect(store.views.length, 1);
      expect(store.cached.keys, contains(101));
      expect(store.viewOf(999), isNull);
      expect(() => store.ingest({'@type': 'chat'}), throwsFormatException);
    });

    test('updateChatLastMessage bumps preview and time', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101, title: 'One'));
      final updated = store.applyUpdate({
        '@type': 'updateChatLastMessage',
        'chat_id': 101,
        'last_message': messageJson(id: 900, chatId: 101, text: 'fresh', date: 1758382000),
        'positions': [
          {
            '@type': 'chatPosition',
            'list': {'@type': 'chatListMain'},
            'order': '900',
            'is_pinned': false,
          },
        ],
      });
      expect(updated?.lastMessagePreview, 'fresh');
      expect(updated?.lastEventTime, 1758382000000);
      final positions = store.cached[101]?['positions'] as List;
      expect((positions.single as Map)['order'], '900');
    });

    test('updateChatReadInbox resets/sets unread count', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101, unread: 5));
      final updated = store.applyUpdate({
        '@type': 'updateChatReadInbox',
        'chat_id': 101,
        'last_read_inbox_message_id': 531,
        'unread_count': 0,
      });
      expect(updated?.unreadCount, 0);
      expect(store.cached[101]?['last_read_inbox_message_id'], 531);
    });

    test('updateChatReadOutbox and unreadMentionCount apply', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101));
      store.applyUpdate({
        '@type': 'updateChatReadOutbox',
        'chat_id': 101,
        'last_read_outbox_message_id': 530,
      });
      expect(store.cached[101]?['last_read_outbox_message_id'], 530);
      store.applyUpdate({
        '@type': 'updateChatUnreadMentionCount',
        'chat_id': 101,
        'unread_mention_count': 2,
      });
      expect(store.cached[101]?['unread_mention_count'], 2);
    });

    test('updateChatTitle renames the view', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101, title: 'Old'));
      final updated = store.applyUpdate({
        '@type': 'updateChatTitle',
        'chat_id': 101,
        'title': 'New',
      });
      expect(updated?.title, 'New');
    });

    test('updateChatPosition appends to positions', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101));
      store.applyUpdate({
        '@type': 'updateChatPosition',
        'chat_id': 101,
        'position': {
          'list': {'@type': 'chatListMain'},
          'order': '778',
        },
      });
      final positions = store.cached[101]?['positions'] as List;
      expect(positions.length, 1);
      expect((positions.single as Map)['order'], '778');
    });

    test('update for an unknown chat is ignored (null)', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      expect(
        store.applyUpdate({'@type': 'updateChatTitle', 'chat_id': 42, 'title': 'X'}),
        isNull,
      );
    });

    test('updateFile/updateUserStatus ingest without chat change', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      store.ingest(chatJson(id: 101, title: 'One'));
      final before = store.viewOf(101);
      store.applyUpdate({
        '@type': 'updateFile',
        'file': {'id': 17, 'local': {'is_downloading_completed': false}},
      });
      store.applyUpdate({
        '@type': 'updateUserStatus',
        'user_id': 7717,
        'status': {'@type': 'userStatusOnline'},
      });
      expect(store.viewOf(101), before);
    });
  });

  group('TdChatStore loadChats/history requests', () {
    test('loadChats emits the loadChats request', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      final call = store.loadChats(limit: 50);
      mock.answerLast();
      await call;
      expect(mock.sentRequests.single['@type'], 'loadChats');
      expect(mock.sentRequests.single['limit'], 50);
    });

    test('history returns chronological unified messages', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      final call = store.history(101, limit: 2);
      mock.answerLast({
        '@type': 'messages',
        'messages': [
          messageJson(id: 531, chatId: 101, text: 'newer'),
          messageJson(id: 529, chatId: 101, text: 'older', date: 1758380000),
        ],
      });
      final history = await call;
      expect(history.length, 2);
      expect(history.first.text, 'older', reason: 'chronological, oldest first');
      expect(history.last.text, 'newer');
      expect(mock.sentRequests.single['@type'], 'getChatHistory');
      expect(mock.sentRequests.single['chat_id'], 101);
      expect(mock.sentRequests.single['from_message_id'], 0);
      expect(mock.sentRequests.single['limit'], 2);
      expect(mock.sentRequests.single['only_local'], false);
    });

    test('history request failure surfaces (error/timeout paths)', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      final call = store.history(101);
      mock.answerLastError(400, 'CHAT_NOT_FOUND');
      await expectLater(
        call,
        throwsA(isA<TdErrorException>().having((e) => e.code, 'code', 400)),
      );
    });

    test('history tolerates non-list messages field', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final store = TdChatStore(bridge: bridge, account: account);
      final call = store.history(101);
      mock.answerLast({'@type': 'messages', 'messages': null});
      expect(await call, isEmpty);
    });
  });
}
