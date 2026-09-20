/// Outgoing message operations over TdBridge (plan-v3 Т-2.4):
/// sendMessage (text + optional reply), editMessageText, deleteMessages,
/// addMessageReaction. Shapes follow the master td_api.tl schema
/// (verified by tools/td_schema_check.py):
/// - sendMessage chat_id:int53 topic_id reply_to:InputMessageReplyTo
///   options:messageSendOptions reply_markup input_message_content
///   → returns message (id, date, is_outgoing).
/// - messageReplyToMessage chat_id:int53 message_id:int53 (…optional
///   fields) is the reply wrapper.
/// - messageSendOptions carries a long field list in master; older TDLib
///   accepted an empty object — omitted here, live behavior is a build
///   image checkpoint (ADR-0001 target schema).
/// - inputMessageText text:formattedText (entities may be empty) …
/// - editMessageText chat_id message_id reply_markup
///   input_message_content → message.
/// - deleteMessages chat_id message_ids:vector<int53> revoke:Bool → ok.
/// - addMessageReaction chat_id message_id reaction_type:ReactionType
///   is_big update_recent_reactions → ok; reactionTypeEmoji emoji:string.
library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';

/// Parses a unified `t:<chatId>` id back to the TDLib int chat id.
int tgParseChatId(String chatId) {
  if (!chatId.startsWith('t:')) {
    throw FormatException('TdMessages: не TG chatId: $chatId');
  }
  final id = int.tryParse(chatId.substring(2));
  if (id == null) {
    throw FormatException('TdMessages: некорректный chatId: $chatId');
  }
  return id;
}

/// Parses a unified message id ('<int53>') to int.
int tgParseMessageId(String messageId) {
  final id = int.tryParse(messageId);
  if (id == null) {
    throw FormatException('TdMessages: некорректный messageId: $messageId');
  }
  return id;
}

class TdMessages {
  final TdBridge bridge;

  TdMessages({required this.bridge});

  /// Sends a text message; [replyToMessageId] wraps into
  /// messageReplyToMessage when set. Returns (message_id, date).
  Future<({String messageId, int timestamp})> sendText(
    int chatId,
    String text, {
    int? replyToMessageId,
  }) async {
    final response = await bridge.send({
      '@type': 'sendMessage',
      'chat_id': chatId,
      'reply_to': replyToMessageId == null
          ? null
          : {
              '@type': 'messageReplyToMessage',
              'chat_id': chatId,
              'message_id': replyToMessageId,
            },
      'input_message_content': {
        '@type': 'inputMessageText',
        'text': {
          '@type': 'formattedText',
          'text': text,
          'entities': const [],
        },
      },
    });
    final id = response['id'];
    final date = response['date'];
    return (
      messageId: id is int ? '$id' : '',
      timestamp: date is int ? date * 1000 : 0,
    );
  }

  /// Edits a message's text (editMessageText). Returns true on ok result.
  Future<bool> editText(int chatId, int messageId, String newText) async {
    await bridge.send({
      '@type': 'editMessageText',
      'chat_id': chatId,
      'message_id': messageId,
      'input_message_content': {
        '@type': 'inputMessageText',
        'text': {
          '@type': 'formattedText',
          'text': newText,
          'entities': const [],
        },
      },
    });
    return true;
  }

  /// Deletes messages (revoke = for everyone when true).
  Future<void> deleteMessages(
    int chatId,
    List<int> messageIds, {
    bool revoke = true,
  }) =>
      bridge.send({
        '@type': 'deleteMessages',
        'chat_id': chatId,
        'message_ids': messageIds,
        'revoke': revoke,
      });

  /// Adds an emoji reaction (reactionTypeEmoji).
  Future<void> addReaction(
    int chatId,
    int messageId,
    String emoji, {
    bool isBig = false,
  }) =>
      bridge.send({
        '@type': 'addMessageReaction',
        'chat_id': chatId,
        'message_id': messageId,
        'reaction_type': {
          '@type': 'reactionTypeEmoji',
          'emoji': emoji,
        },
        'is_big': isBig,
        'update_recent_reactions': false,
      });
}
