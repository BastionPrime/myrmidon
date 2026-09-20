/// NotificationCenter skeleton (plan-v3 Т-1.10, из Т-3.6 v2).
///
/// Единственная точка формирования уведомлений: BackendEvent (любой
/// бэкенд) → решение показать/сгруппировать → пост через [NotificationPoster]
/// (flutter_local_notifications в продакшне, шов для тестов).
///
/// ВАЖНО (решение владельца п.2.5): источник события НЕ известен и НЕ
/// используется — живое соединение FGS (Т-1.9), FCM или webpush приходят
/// как одинаковые BackendEvent; код, где FCM — единственный путь
/// доставки, блокируется на ревью. Здесь FCM не упоминается вовсе.
library;

import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';

/// Channel ids (план: сообщения, звонки MAX, служебный).
enum NotificationChannel { messages, calls, service }

/// Presentation-independent notification request the poster receives.
class NotificationRequest {
  final NotificationChannel channel;

  /// Group key: account+chat → группировка по чату (план).
  final String groupKey;
  final String title;
  final String body;
  final int id;

  const NotificationRequest({
    required this.channel,
    required this.groupKey,
    required this.title,
    required this.body,
    required this.id,
  });
}

/// Poster seam: the only place that talks to the platform notification
/// API (flutter_local_notifications in the build image).
abstract class NotificationPoster {
  Future<void> post(NotificationRequest request);
  Future<void> cancelGroup(String groupKey);
  Future<void> setBadge(int count);
}

/// Каркас: routing BackendEvent → NotificationRequest. Поля события
/// (kind/chatId/text/…) — всё, что используется; никакого поля источника.
class NotificationCenter {
  final NotificationPoster poster;

  NotificationCenter({required this.poster});

  int _badge = 0;

  final _perChat = <String, int>{};

  int get badge => _badge;

  int unreadInChat(String groupKey) => _perChat[groupKey] ?? 0;

  /// Focused: активный чат (пользователь смотрит) — уведомления
  /// подавляются, событие только инкрементит счётчик.
  String? focusedChat;

  /// Обрабатывает событие любого бэкенда. Возвращает запрос, улетевший в
  /// poster (null — событие не уведомимо или подавлено).
  Future<NotificationRequest?> handle(BackendEvent event) {
    switch (event.kind) {
      case BackendEventKind.newMessage:
        return _handleNewMessage(event);
      case BackendEventKind.incomingCall:
        return _handleIncomingCall(event);
      case BackendEventKind.chatRead:
        return _handleChatRead(event);
      case BackendEventKind.messageDeleted:
      case BackendEventKind.messageEdited:
      case BackendEventKind.typing:
      case BackendEventKind.ghostModeChanged:
      case BackendEventKind.connected:
      case BackendEventKind.disconnected:
        return Future.value(null);
    }
  }

  Future<NotificationRequest?> _handleNewMessage(BackendEvent event) async {
    final chatId = event.chatId;
    if (chatId == null) return null;
    final groupKey = '${event.account.storageId}:$chatId';
    final count = (_perChat[groupKey] ?? 0) + 1;
    _perChat[groupKey] = count;
    _badge++;
    await poster.setBadge(_badge);

    if (focusedChat == groupKey) {
      return null;
    }

    final request = NotificationRequest(
      channel: NotificationChannel.messages,
      groupKey: groupKey,
      title: _chatTitle(event),
      body: count > 1 ? '$count новых сообщений' : (event.text ?? 'Новое сообщение'),
      id: _stableId(groupKey),
    );
    await poster.post(request);
    return request;
  }

  Future<NotificationRequest?> _handleIncomingCall(BackendEvent event) async {
    final chatId = event.chatId;
    if (chatId == null) return null;
    final groupKey = '${event.account.storageId}:$chatId';
    final request = NotificationRequest(
      channel: NotificationChannel.calls,
      groupKey: groupKey,
      title: 'Входящий звонок',
      body: _chatTitle(event),
      id: _stableId(groupKey) + 1,
    );
    await poster.post(request);
    return request;
  }

  Future<NotificationRequest?> _handleChatRead(BackendEvent event) async {
    final chatId = event.chatId;
    if (chatId == null) return null;
    final groupKey = '${event.account.storageId}:$chatId';
    final had = _perChat.remove(groupKey) ?? 0;
    if (had > 0) {
      _badge = _badge - had;
      if (_badge < 0) _badge = 0;
      await poster.setBadge(_badge);
      await poster.cancelGroup(groupKey);
    }
    return null;
  }

  /// Пользователь открыл чат: счётчик и уведомления группы гаснут.
  Future<void> chatOpened(AccountKey account, String chatId) async {
    final groupKey = '${account.storageId}:$chatId';
    final had = _perChat.remove(groupKey) ?? 0;
    if (had > 0) {
      _badge = _badge - had;
      if (_badge < 0) _badge = 0;
      await poster.setBadge(_badge);
    }
    await poster.cancelGroup(groupKey);
  }

  String _chatTitle(BackendEvent event) {
    final sender = event.senderId;
    if (sender != null) {
      final numeric = sender.startsWith('u:') ? sender.substring(2) : sender;
      return 'Аккаунт ${numeric.isEmpty ? event.account.storageId : numeric}';
    }
    return 'Чат';
  }

  int _stableId(String groupKey) => groupKey.hashCode & 0x7fffffff;

  Future<void> dispose() async {
    _perChat.clear();
    _badge = 0;
    await poster.setBadge(0);
  }
}
