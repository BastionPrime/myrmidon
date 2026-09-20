/// Ghost mode seam over TdBridge (plan-v3 4.4 / Т-2.8).
///
/// Mirrors the MAX «невидимка» semantics (max_backend.dart:159-174) on the
/// TDLib side; per-account setting, applied immediately and re-applied on
/// any later call — the backend holds no hidden state beyond [settings]:
/// - ghostRead    — do NOT call `viewMessages`/`openChat` (markRead becomes
///   a no-op, unread counters stay client-side only);
/// - ghostTyping  — do NOT call `sendChatAction` (typing indicators are
///   never sent, plan: «не вызывать sendChatAction»);
/// - ghostOnline  — `setOption name:"online" value:optionValueBoolean{false}`
///   and the backend never reports online on activity (td_api.tl:15662,
///   optionValueBoolean:8889).
///
/// Wire shapes follow the master td_api.tl schema, verified by
/// tools/td_schema_check.py:
/// - setOption name:string value:OptionValue = Ok;          (15662)
/// - optionValueBoolean value:Bool = OptionValue;            (8889)
/// - viewMessages chat_id:int53 message_ids:vector<int53>
///   source:MessageSource force_read:Bool = Ok;              (13230)
/// - openChat chat_id:int53 = Ok;                            (13219)
/// - sendChatAction chat_id:int53 topic_id:MessageTopic
///   business_connection_id:string action:ChatAction = Ok;   (13191)
library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';

/// Per-account ghost settings (plan 4.4: «настройка на аккаунт»).
class TdGhostSettings {
  final bool ghostRead;
  final bool ghostTyping;
  final bool ghostOnline;

  const TdGhostSettings({
    this.ghostRead = true,
    this.ghostTyping = true,
    this.ghostOnline = true,
  });

  static const TdGhostSettings off = TdGhostSettings(
    ghostRead: false,
    ghostTyping: false,
    ghostOnline: false,
  );

  TdGhostSettings copyWith({bool? ghostRead, bool? ghostTyping, bool? ghostOnline}) =>
      TdGhostSettings(
        ghostRead: ghostRead ?? this.ghostRead,
        ghostTyping: ghostTyping ?? this.ghostTyping,
        ghostOnline: ghostOnline ?? this.ghostOnline,
      );

  @override
  bool operator ==(Object other) =>
      other is TdGhostSettings &&
      other.ghostRead == ghostRead &&
      other.ghostTyping == ghostTyping &&
      other.ghostOnline == ghostOnline;

  @override
  int get hashCode => Object.hash(ghostRead, ghostTyping, ghostOnline);

  @override
  String toString() =>
      'TdGhostSettings(read:$ghostRead, typing:$ghostTyping, online:$ghostOnline)';
}

/// Thin guard emitted by [TdGhost.markRead] when ghost-read is on.
class TdGhostSuppressed implements Exception {
  final String method;

  const TdGhostSuppressed(this.method);

  @override
  String toString() => 'TdGhostSuppressed: $method suppressed by ghost mode';
}

/// Ghost-mode policy holder. The TelegramBackend consults [settings]
/// before markRead/setTyping and re-applies the online option via
/// [applyOnline] whenever ghostOnline changes (or on reconnect, when the
/// option resets — re-apply, not assume).
class TdGhost {
  final TdBridge bridge;

  /// Ghost starts OFF: reading/typing/online are live until the backend
  /// explicitly applies a ghost profile right after connect (plan
  /// invariant — a session raised in ghost gets setGhostMode immediately,
  /// not implicitly by default).
  TdGhostSettings _settings = TdGhostSettings.off;

  TdGhost({required this.bridge});

  TdGhostSettings get settings => _settings;

  /// Sets the per-account ghost profile and, when ghostOnline is ON,
  /// immediately sends `setOption "online" = false` so the session does not
  /// surface as online (plan invariant: a session raised in ghost gets
  /// setGhostMode right after connect, before being declared active).
  /// Turning ghostOnline off restores TDLib's automatic online management
  /// with `optionValueEmpty` (OptionManager.cpp: set_is_online(true) for
  /// optionValueEmpty) — a forced `true` would pin the status instead of
  /// returning control to the client.
  Future<void> setGhostMode(TdGhostSettings next) async {
    final wasOnline = _settings.ghostOnline;
    _settings = next;
    if (next.ghostOnline) {
      await _setOnlineOption(false);
    } else if (wasOnline) {
      // Leaving online-ghost: hand online control back to TDLib. Entering
      // a ghost profile that never touched online sends nothing.
      await _restoreOnlineAuto();
    }
  }

  /// Re-applies the current ghostOnline state after a reconnect (TDLib
  /// options reset on client restart); safe to call repeatedly.
  Future<void> reapplyOnline() {
    if (!_settings.ghostOnline) return Future.value();
    return _setOnlineOption(false);
  }

  Future<void> _setOnlineOption(bool value) => bridge.send({
        '@type': 'setOption',
        'name': 'online',
        'value': {
          '@type': 'optionValueBoolean',
          'value': value,
        },
      });

  /// Restores TDLib's automatic online management (OptionManager.cpp:
  /// optionValueEmpty → set_is_online(true)).
  Future<void> _restoreOnlineAuto() => bridge.send({
        '@type': 'setOption',
        'name': 'online',
        'value': {'@type': 'optionValueEmpty'},
      });

  /// markRead path: suppressed (no wire calls at all) while ghostRead is
  /// on — TDLib `viewMessages`/`openChat` are exactly what must not fire.
  /// Returns true when the caller should proceed with the wire calls.
  bool shouldMarkRead() => !_settings.ghostRead;

  /// setTyping path: suppressed while ghostTyping is on.
  bool shouldSendTyping() => !_settings.ghostTyping;

  /// Builds the `viewMessages` request for the non-ghost path
  /// (td_api.tl:13230); kept here so the ghost decision and the shape live
  /// in one place. force_read marks the messages read on the server side.
  Map<String, dynamic> viewMessagesRequest(int chatId, List<int> messageIds) => {
        '@type': 'viewMessages',
        'chat_id': chatId,
        'message_ids': messageIds,
        'force_read': true,
      };

  /// Builds the `openChat` request (td_api.tl:13219) for the non-ghost path.
  Map<String, dynamic> openChatRequest(int chatId) => {
        '@type': 'openChat',
        'chat_id': chatId,
      };

  /// Builds the `sendChatAction` request (td_api.tl:13191) for the
  /// non-ghost typing path. topic_id/business_connection_id are optional
  /// («pass null if none») and omitted; action must be a ChatAction object
  /// (e.g. chatActionTyping) supplied by the caller.
  Map<String, dynamic> sendChatActionRequest(int chatId, Map<String, dynamic> action) => {
        '@type': 'sendChatAction',
        'chat_id': chatId,
        'action': action,
      };

  /// Convenience: full typing call — suppressed (no-op) in ghostTyping.
  Future<void> sendTyping(int chatId, Map<String, dynamic> action) async {
    if (_settings.ghostTyping) return;
    await bridge.send(sendChatActionRequest(chatId, action));
  }

  /// Convenience: full markRead call — suppressed in ghostRead.
  Future<void> markRead(int chatId, List<int> messageIds) async {
    if (_settings.ghostRead) return;
    await bridge.send(openChatRequest(chatId));
    await bridge.send(viewMessagesRequest(chatId, messageIds));
  }

  /// Disables all ghost features (UI toggle off); restores online.
  Future<void> disable() => setGhostMode(TdGhostSettings.off);
}
