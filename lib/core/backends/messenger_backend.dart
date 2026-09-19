/// The backend contract (plan-v3 4.3): everything the unified application
/// layer may ask of a messenger network for one account.
///
/// Implementations: MaxBackend (T-1.4), TelegramBackend (Phase 2). The
/// interface lives in lib/core/backends so the app layer never imports
/// network-specific code.
library;

import 'dart:async';

import '../accounts/account_key.dart';
import '../models/unified/backend_event.dart';
import '../models/unified/unified_chat.dart';
import 'capabilities.dart';

/// Connection state of one backend session.
enum BackendState { disconnected, connecting, online, paused }

class SendResult {
  final String messageId;
  final int timestamp;

  const SendResult({required this.messageId, required this.timestamp});
}

abstract class MessengerBackend {
  /// Account this backend serves.
  AccountKey get account;

  Capabilities get capabilities;

  BackendState get state;

  /// Event stream (message updates, connection changes, calls). Does not
  /// identify the transport source — see BackendEvent.
  Stream<BackendEvent> get events;

  Stream<BackendState> get stateChanges;

  Future<List<UnifiedChat>> chats();

  Future<List<UnifiedMessage>> history(String chatId, {int limit = 50});

  Future<SendResult> sendText(String chatId, String text);

  Future<void> sendMedia(String chatId, String filePath);

  Future<void> editText(String chatId, String messageId, String newText);

  Future<void> deleteMessages(String chatId, List<String> messageIds);

  Future<void> setReaction(String chatId, String messageId, String reaction);

  Future<void> markRead(String chatId);

  Future<void> setTyping(String chatId, bool typing);

  Future<void> downloadMedia(String messageId, String targetPath);

  Future<void> registerPush(String pushToken);

  Future<void> unregisterPush(String pushToken);

  Future<void> setGhostMode(bool enabled);

  /// Releases the session (background/parallel switches); the backend stays
  /// constructible for reconnect.
  Future<void> pause();

  Future<void> resume();

  Future<void> dispose();
}
