/// Chats and history over TdBridge (plan-v3 Т-2.3): loadChats /
/// getChatHistory requests and TG→Unified mappers with update application
/// (plan 4.4: updateChatLastMessage / updateChatPosition /
/// updateChatReadInbox / updateChatReadOutbox / updateFile /
/// updateUserStatus and the other mandatory updates already scripted in
/// the mock).
///
/// TDLib json shapes used here (verified against the official docs):
/// - getChats/chat responses carry `id`, `type.@type`
///   (chatTypePrivate | chatTypeBasicGroup | chatTypeSupergroup |
///   chatTypeSecret), `title`, `last_message`, `positions`,
///   `unread_count`, `last_read_inbox_message_id`.
/// - chatTypeSupergroup additionally carries `is_channel` (bool).
/// - message: `id`, `chat_id`, `sender_id` (messageSenderUser{user_id} |
///   messageSenderChat{chat_id}), `content.@type` (messageText wraps
///   formattedText.text), `date` (unix seconds), `is_outgoing`.
/// - getChatHistory(chat_id, from_message_id, offset, limit, only_local)
///   returns `messages` in reverse chronological order (decreasing id).
library;

import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/models/unified/unified_chat.dart';

/// Unified id of a Telegram chat (plan 4.5: `tg:<acc>:<chatId>`; the
/// account part lives in UnifiedChat.account, so the chat id stays
/// `t:<chatId>` within one backend).
String tgChatId(int chatId) => 't:$chatId';

/// Unified sender id from a TDLib MessageSender object
/// (messageSenderUser{user_id} / messageSenderChat{chat_id}).
String? tgSenderId(Map<String, dynamic>? sender) {
  if (sender == null) return null;
  switch (sender['@type']) {
    case 'messageSenderUser':
      final id = sender['user_id'];
      return id is int ? 'u:$id' : null;
    case 'messageSenderChat':
      final id = sender['chat_id'];
      return id is int ? 't:$id' : null;
    default:
      return null;
  }
}

/// Plain text of a TDLib message content for previews/unified text.
String tgContentText(Map<String, dynamic>? content) {
  if (content == null) return '';
  final type = content['@type'];
  switch (type) {
    case 'messageText':
      final text = content['text'];
      return text is Map && text['text'] is String ? text['text'] as String : '';
    default:
      return '';
  }
}

/// Whether a chat json is a group/channel (unified isGroup).
bool tgChatIsGroup(Map<String, dynamic> chat) {
  final type = chat['type'];
  if (type is! Map) return false;
  switch (type['@type']) {
    case 'chatTypeBasicGroup':
    case 'chatTypeSupergroup':
    case 'chatTypeSecret':
      return true;
    default:
      return false;
  }
}

/// Chat title with the same fallback as the MAX mapper («Чат <id>»).
String tgChatTitle(Map<String, dynamic> chat) {
  final title = chat['title'];
  final id = chat['id'];
  return title is String && title.isNotEmpty ? title : 'Чат $id';
}

/// Milliseconds since epoch of the last_message date (unix seconds).
int tgLastEventTime(Map<String, dynamic> chat) {
  final last = chat['last_message'];
  if (last is Map && last['date'] is int) {
    return (last['date'] as int) * 1000;
  }
  return 0;
}

String? tgLastMessagePreview(Map<String, dynamic> chat) {
  final last = chat['last_message'];
  if (last is! Map) return null;
  final text = tgContentText(last['content'] as Map<String, dynamic>?);
  return text.isEmpty ? null : text;
}

/// Chat store: caches chats received through loadChats + updates, answers
/// history queries with getChatHistory. Pure translation layer — no
/// network semantics beyond the bridge.
class TdChatStore {
  final TdBridge bridge;
  final AccountKey account;

  final Map<int, Map<String, dynamic>> _chats = {};

  TdChatStore({required this.bridge, required this.account});

  /// Cached chat jsons (defensive copies).
  Map<int, Map<String, dynamic>> get cached => Map.of(_chats);

  /// Emits loadChats and, on ok, requests the chat list snapshot from the
  /// bridge's cache — TDLib delivers chats as separate `chat` objects /
  /// `updateNewChat` updates; this store ingests them through [ingest].
  Future<void> loadChats({int limit = 100}) async {
    await bridge.send({'@type': 'loadChats', 'limit': limit});
  }

  /// Ingests a full `chat` object (from getChats response `chat_ids` →
  /// getChat, or updateNewChat). Returns the unified view.
  UnifiedChat ingest(Map<String, dynamic> chat) {
    final id = chat['id'];
    if (id is! int) {
      throw const FormatException('TdChatStore.ingest: chat without int id');
    }
    _chats[id] = Map<String, dynamic>.of(chat);
    return viewOf(id)!;
  }

  /// Unified view of an ingested chat, or null when unknown.
  UnifiedChat? viewOf(int chatId) {
    final chat = _chats[chatId];
    if (chat == null) return null;
    return mapTgChat(account, chat);
  }

  /// All ingested chats as unified views (position order is the caller's
  /// business — ChatListAggregator sorts by lastEventTime).
  List<UnifiedChat> get views => [
        for (final id in _chats.keys) viewOf(id)!,
      ];

  /// getChatHistory page (reverse chronological). `fromMessageId` = 0 for
  /// the newest page. Returns unified messages in chronological order
  /// (oldest first), like the MAX mapper does.
  Future<List<UnifiedMessage>> history(
    int chatId, {
    int fromMessageId = 0,
    int limit = 50,
  }) async {
    final response = await bridge.send({
      '@type': 'getChatHistory',
      'chat_id': chatId,
      'from_message_id': fromMessageId,
      'offset': 0,
      'limit': limit,
      'only_local': false,
    });
    final messages = response['messages'];
    final raw = messages is List ? messages : const [];
    return [
      for (final m in raw.reversed)
        if (m is Map)
          mapTgMessage(
            account,
            m.cast<String, dynamic>(),
          ),
    ];
  }

  /// Applies a 4.4 update json to the cached chat. Returns the updated
  /// unified view, or null when the update targets an unknown chat /
  /// carries no unified effect (updateFile / updateUserStatus are
  /// ingested but do not change the chat list view).
  UnifiedChat? applyUpdate(Map<String, dynamic> update) {
    final chatId = update['chat_id'];
    final chat = chatId is int ? _chats[chatId] : null;
    if (chat == null) return null;
    switch (update['@type']) {
      case 'updateChatLastMessage':
        final last = update['last_message'];
        if (last is Map) {
          chat['last_message'] = Map<String, dynamic>.of(last.cast<String, dynamic>());
        }
        final order = update['order'];
        if (order is String) {
          chat['order'] = order;
        }
      case 'updateChatReadInbox':
        chat['last_read_inbox_message_id'] =
            update['last_read_inbox_message_id'] ?? chat['last_read_inbox_message_id'];
        final unread = update['unread_count'];
        if (unread is int) {
          chat['unread_count'] = unread;
        }
      case 'updateChatReadOutbox':
        chat['last_read_outbox_message_id'] =
            update['last_read_outbox_message_id'] ?? chat['last_read_outbox_message_id'];
      case 'updateChatUnreadMentionCount':
        chat['unread_mention_count'] = update['unread_mention_count'] ?? 0;
      case 'updateChatTitle':
        chat['title'] = update['title'];
      case 'updateChatPosition':
        final position = update['position'];
        if (position is Map) {
          final positions = (chat['positions'] as List?)?.toList() ?? [];
          positions.add(Map<String, dynamic>.of(position.cast<String, dynamic>()));
          chat['positions'] = positions;
        }
      case 'updateChatPhoto':
        chat['photo'] = update['photo'];
      case 'updateOption':
      case 'updateUser':
      case 'updateUserStatus':
      case 'updateFile':
      case 'updateConnectionState':
      case 'updateNewMessage':
      case 'updateMessageContent':
      case 'updateDeleteMessages':
      case 'updateChatAction':
        break;
      default:
        break;
    }
    return viewOf(chatId as int);
  }
}

/// TG chat json → UnifiedChat (plan 4.5 mapping table).
UnifiedChat mapTgChat(AccountKey account, Map<String, dynamic> chat) {
  final id = chat['id'];
  final unread = chat['unread_count'];
  return UnifiedChat(
    account: account,
    id: tgChatId(id is int ? id : 0),
    title: tgChatTitle(chat),
    isGroup: tgChatIsGroup(chat),
    lastEventTime: tgLastEventTime(chat),
    unreadCount: unread is int ? unread : 0,
    lastMessagePreview: tgLastMessagePreview(chat),
  );
}

/// TG message json → UnifiedMessage.
UnifiedMessage mapTgMessage(AccountKey account, Map<String, dynamic> message) {
  final id = message['id'];
  final chatId = message['chat_id'];
  final date = message['date'];
  return UnifiedMessage(
    account: account,
    chatId: tgChatId(chatId is int ? chatId : 0),
    id: id is int ? '$id' : '${message['id']}',
    senderId: tgSenderId(message['sender_id'] as Map<String, dynamic>?) ?? '',
    text: tgContentText(message['content'] as Map<String, dynamic>?),
    timestamp: date is int ? date * 1000 : 0,
    status: message['is_outgoing'] == true
        ? UnifiedMessageStatus.sent
        : UnifiedMessageStatus.delivered,
  );
}
