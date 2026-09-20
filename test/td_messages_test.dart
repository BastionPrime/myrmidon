library;

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_messages.dart';

import 'mock_td_client.dart';

void main() {
  group('id parsers', () {
    test('t:<id> and message ids parse', () {
      expect(tgParseChatId('t:101'), 101);
      expect(tgParseMessageId('531'), 531);
    });

    test('non-TG or malformed ids throw FormatException', () {
      expect(() => tgParseChatId('c:101'), throwsFormatException);
      expect(() => tgParseChatId('t:abc'), throwsFormatException);
      expect(() => tgParseMessageId('x'), throwsFormatException);
    });
  });

  group('TdMessages.sendText', () {
    test('sends the schema-shaped sendMessage request', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.sendText(101, 'привет');
      mock.answerLast({
        '@type': 'message',
        'id': 900,
        'date': 1758382000,
        'is_outgoing': true,
      });
      final result = await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'sendMessage');
      expect(request['chat_id'], 101);
      final content = request['input_message_content'] as Map;
      expect(content['@type'], 'inputMessageText');
      final text = content['text'] as Map;
      expect(text['@type'], 'formattedText');
      expect(text['text'], 'привет');
      expect(text['entities'], isEmpty);
      expect(request['reply_to'], isNull,
          reason: 'no reply by default');

      expect(result.messageId, '900');
      expect(result.timestamp, 1758382000000);
    });

    test('reply wraps into messageReplyToMessage', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.sendText(101, 'reply!', replyToMessageId: 531);
      mock.answerLast({
        '@type': 'message',
        'id': 901,
        'date': 1758382100,
      });
      await call;

      final reply = mock.sentRequests.single['reply_to'] as Map;
      expect(reply['@type'], 'messageReplyToMessage');
      expect(reply['chat_id'], 101);
      expect(reply['message_id'], 531);
    });

    test('TDLib error on send fails the future', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.sendText(101, 'x');
      mock.answerLastError(400, 'CHAT_RESTRICTED');
      await expectLater(
        call,
        throwsA(
          isA<TdErrorException>()
              .having((e) => e.code, 'code', 400)
              .having((e) => e.message, 'message', 'CHAT_RESTRICTED'),
        ),
      );
    });
  });

  group('TdMessages.editText', () {
    test('sends editMessageText with new formatted text', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.editText(101, 531, 'исправлено');
      mock.answerLast({
        '@type': 'message',
        'id': 531,
        'date': 1758380000,
      });
      expect(await call, isTrue);

      final request = mock.sentRequests.single;
      expect(request['@type'], 'editMessageText');
      expect(request['chat_id'], 101);
      expect(request['message_id'], 531);
      final content = request['input_message_content'] as Map;
      expect((content['text'] as Map)['text'], 'исправлено');
    });
  });

  group('TdMessages.deleteMessages', () {
    test('sends message_ids vector with revoke', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.deleteMessages(101, [529, 531], revoke: true);
      mock.answerLast();
      await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'deleteMessages');
      expect(request['chat_id'], 101);
      expect(request['message_ids'], [529, 531]);
      expect(request['revoke'], true);
    });

    test('empty list still goes through (TDLib validates)', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.deleteMessages(101, []);
      mock.answerLast();
      await call;
      expect(mock.sentRequests.single['message_ids'], isEmpty);
    });
  });

  group('TdMessages.addReaction', () {
    test('sends reactionTypeEmoji payload', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final messages = TdMessages(bridge: bridge);

      final call = messages.addReaction(101, 531, '👍', isBig: true);
      mock.answerLast();
      await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'addMessageReaction');
      expect(request['chat_id'], 101);
      expect(request['message_id'], 531);
      final reaction = request['reaction_type'] as Map;
      expect(reaction['@type'], 'reactionTypeEmoji');
      expect(reaction['emoji'], '👍');
      expect(request['is_big'], true);
      expect(request['update_recent_reactions'], false);
    });
  });
}
