/// MAX→Unified mappers (plan-v3 Т-1.4: «мапперы MAX→Unified с тестами»).
library;

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart' show BackendState;
import 'package:wellmagram/core/models/unified/unified_chat.dart';

/// Chats are stringified (`c:<id>`) to stay backend-neutral in unified models.
String maxChatId(int chatId) => 'c:$chatId';

UnifiedChat mapChat(AccountKey account, MaxCachedChat chat) => UnifiedChat(
      account: account,
      id: maxChatId(chat.id),
      title: (chat.title == null || chat.title!.isEmpty)
          ? 'Чат ${chat.id}'
          : chat.title!,
      isGroup: chat.isGroup,
      avatarUrl: chat.iconUrl,
      lastEventTime: chat.lastEventTime,
      unreadCount: chat.unreadCount,
      lastMessagePreview: chat.lastMsgText,
    );

UnifiedMessage mapMessage(AccountKey account, MaxCachedMessage message) =>
    UnifiedMessage(
      account: account,
      chatId: maxChatId(message.chatId),
      id: message.id,
      senderId: 'u:${message.senderId}',
      text: message.text ?? '',
      timestamp: message.time,
    );

BackendState mapState(MaxSessionState state) => switch (state) {
      MaxSessionState.online => BackendState.online,
      MaxSessionState.connecting => BackendState.connecting,
      MaxSessionState.reconnecting => BackendState.connecting,
      MaxSessionState.disconnected => BackendState.disconnected,
    };

/// notifMessage push (opcode 128) → BackendEvent.newMessage; typing (65) →
/// typing; other opcodes map to null (handled by upstream modules locally).
BackendEvent? mapPush(AccountKey account, MaxPushPacket packet) {
  final chatId = packet.payload['chatId'];
  final msg = packet.message;
  switch (packet.opcode) {
    case MaxOpcode.notifMessage:
      final id = msg['id']?.toString();
      if (chatId is! int || id == null || id.isEmpty) return null;
      return BackendEvent.message(
        account: account,
        chatId: maxChatId(chatId),
        messageId: id,
        text: msg['text'] as String?,
        senderId: msg['sender'] is int ? 'u:${msg['sender']}' : null,
        timestamp: (msg['time'] as int?) ?? 0,
      );
    case MaxOpcode.msgTyping:
      if (chatId is! int) return null;
      final sender = packet.payload['userId'];
      return BackendEvent(
        kind: BackendEventKind.typing,
        account: account,
        chatId: maxChatId(chatId),
        senderId: sender is int ? 'u:$sender' : null,
        timestamp: DateTime.now().millisecondsSinceEpoch,
      );
    default:
      return null;
  }
}
