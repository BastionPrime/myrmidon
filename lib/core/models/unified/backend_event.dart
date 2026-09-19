/// Backend-neutral event stream model (plan-v3 4.3/4.6).
///
/// Deliberately does NOT carry the transport source (FCM vs live socket):
/// NotificationCenter (T-1.10) must treat every event identically
/// (owner decision 2.5). Backends emit these; the app layer subscribes.
library;

import '../../accounts/account_key.dart';

enum BackendEventKind {
  connected,
  disconnected,
  newMessage,
  messageEdited,
  messageDeleted,
  chatRead,
  typing,
  incomingCall,
  ghostModeChanged,
}

class BackendEvent {
  final BackendEventKind kind;
  final AccountKey account;
  final String? chatId;
  final String? messageId;
  final String? text;
  final String? senderId;

  /// Milliseconds since epoch.
  final int timestamp;

  const BackendEvent({
    required this.kind,
    required this.account,
    required this.timestamp,
    this.chatId,
    this.messageId,
    this.text,
    this.senderId,
  });

  /// Convenience constructor for message-shaped events.
  const BackendEvent.message({
    required this.account,
    required this.chatId,
    required this.messageId,
    this.text,
    this.senderId,
    required this.timestamp,
    this.kind = BackendEventKind.newMessage,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is BackendEvent &&
          other.kind == kind &&
          other.account == account &&
          other.chatId == chatId &&
          other.messageId == messageId &&
          other.text == text &&
          other.senderId == senderId &&
          other.timestamp == timestamp;

  @override
  int get hashCode =>
      Object.hash(kind, account, chatId, messageId, text, senderId, timestamp);
}
