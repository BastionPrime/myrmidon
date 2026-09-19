/// Unified chat/message models (plan-v3 4.5): backend-agnostic view of a
/// conversation used by the application layer and UI.
library;

import '../../accounts/account_key.dart';
import 'backend_event.dart';

class UnifiedChat {
  final AccountKey account;
  final String id;
  final String title;
  final bool isGroup;
  final String? avatarUrl;
  final int lastEventTime;

  /// Milliseconds since epoch; 0 when unknown.
  final int unreadCount;

  final String? lastMessagePreview;

  const UnifiedChat({
    required this.account,
    required this.id,
    required this.title,
    required this.isGroup,
    required this.lastEventTime,
    this.avatarUrl,
    this.unreadCount = 0,
    this.lastMessagePreview,
  });

  UnifiedChat copyWith({
    String? title,
    bool? isGroup,
    String? avatarUrl,
    int? lastEventTime,
    int? unreadCount,
    String? lastMessagePreview,
  }) =>
      UnifiedChat(
        account: account,
        id: id,
        title: title ?? this.title,
        isGroup: isGroup ?? this.isGroup,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        lastEventTime: lastEventTime ?? this.lastEventTime,
        unreadCount: unreadCount ?? this.unreadCount,
        lastMessagePreview: lastMessagePreview ?? this.lastMessagePreview,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UnifiedChat &&
          other.account == account &&
          other.id == id &&
          other.title == title &&
          other.isGroup == isGroup &&
          other.lastEventTime == lastEventTime &&
          other.unreadCount == unreadCount &&
          other.lastMessagePreview == lastMessagePreview;

  @override
  int get hashCode =>
      Object.hash(account, id, title, isGroup, lastEventTime, unreadCount, lastMessagePreview);
}

enum UnifiedMessageStatus { pending, sent, delivered, read, failed }

class UnifiedMessage {
  final AccountKey account;
  final String chatId;
  final String id;
  final String senderId;
  final String text;

  /// Milliseconds since epoch.
  final int timestamp;

  final UnifiedMessageStatus status;
  final String? replyToId;

  const UnifiedMessage({
    required this.account,
    required this.chatId,
    required this.id,
    required this.senderId,
    required this.text,
    required this.timestamp,
    this.status = UnifiedMessageStatus.sent,
    this.replyToId,
  });

  UnifiedMessage copyWith({
    String? text,
    UnifiedMessageStatus? status,
    String? replyToId,
  }) =>
      UnifiedMessage(
        account: account,
        chatId: chatId,
        id: id,
        senderId: senderId,
        text: text ?? this.text,
        timestamp: timestamp,
        status: status ?? this.status,
        replyToId: replyToId ?? this.replyToId,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UnifiedMessage &&
          other.account == account &&
          other.chatId == chatId &&
          other.id == id &&
          other.senderId == senderId &&
          other.text == text &&
          other.timestamp == timestamp &&
          other.status == status &&
          other.replyToId == replyToId;

  @override
  int get hashCode =>
      Object.hash(account, chatId, id, senderId, text, timestamp, status, replyToId);
}

/// Maps a generic backend event onto a chat, e.g. NewMessage → preview bump.
UnifiedChat applyEventToChat(UnifiedChat chat, BackendEvent event) {
  if (event.account != chat.account || event.chatId != chat.id) return chat;
  return switch (event.kind) {
    BackendEventKind.newMessage => chat.copyWith(
        lastEventTime: event.timestamp,
        lastMessagePreview: _previewOf(event),
        unreadCount: chat.unreadCount + 1,
      ),
    BackendEventKind.chatRead => chat.copyWith(unreadCount: 0),
    _ => chat,
  };
}

String? _previewOf(BackendEvent event) => event.text?.isEmpty ?? true ? null : event.text;
