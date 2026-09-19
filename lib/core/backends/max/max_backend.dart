/// MAX adapter over the MessengerBackend contract (plan-v3 Т-1.4).
///
/// Wraps upstream Api/AccountModule/MessagesModule/ChatsModule through the
/// [MaxApiLike] seam: sessions built via [SessionSpecBuilder] (kolibri
/// SessionOptions from the spoof profile, config host, proxy URL),
/// registerPush delegates to the privacy module (opcode config=22),
/// ghost mode reuses the upstream «невидимка» (pingInteractive), and push
/// packets are mapped to unified BackendEvents.
library;

import 'dart:async';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/capabilities.dart';
import 'package:wellmagram/core/backends/max/max_api_seam.dart';
import 'package:wellmagram/core/backends/max/max_mappers.dart';
import 'package:wellmagram/core/backends/messenger_backend.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/models/unified/unified_chat.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';

class MaxBackend implements MessengerBackend {
  final AccountKey _account;
  final MaxApiLike _api;
  final CredentialStore _credentials;
  final SessionSpecBuilder _specBuilder;

  StreamSubscription<MaxPushPacket>? _pushSub;
  StreamSubscription<MaxSessionState>? _stateSub;
  final _eventController = StreamController<BackendEvent>.broadcast();
  final _stateController = StreamController<BackendState>.broadcast();

  bool _ghostMode = false;
  bool _paused = false;
  bool _disposed = false;

  MaxBackend({
    required AccountKey account,
    required MaxApiLike api,
    required CredentialStore credentials,
    required SessionSpecBuilder specBuilder,
  })  : _account = account,
        _api = api,
        _credentials = credentials,
        _specBuilder = specBuilder {
    _stateSub = _api.stateStream.listen((state) {
      if (!_stateController.isClosed) {
        _stateController.add(mapState(state));
      }
    });
    _pushSub = _api.pushStream.listen((packet) {
      final event = mapPush(_account, packet);
      if (event != null && !_eventController.isClosed) {
        _eventController.add(event);
      }
    });
  }

  @override
  AccountKey get account => _account;

  @override
  Capabilities get capabilities => Capabilities.max;

  @override
  BackendState get state {
    if (_paused) return BackendState.paused;
    return mapState(_api.state);
  }

  @override
  Stream<BackendEvent> get events => _eventController.stream;

  @override
  Stream<BackendState> get stateChanges => _stateController.stream;

  /// Connects through kolibri SessionOptions and logs in with the stored
  /// credential (TokenStorage-authenticated flow of upstream, but per-account).
  Future<void> connectAndLogin() async {
    _requireAlive();
    final token = await _credentials.readToken(_account);
    if (token == null) {
      throw StateError('MaxBackend: no credential for ${_account.storageId}');
    }
    final spec = await _specBuilder.build(_account);
    await _api.connect(spec: spec);
    await _api.login(token: token);
  }

  @override
  Future<List<UnifiedChat>> chats() async => [
        for (final chat in await _api.getChats()) mapChat(_account, chat),
      ];

  @override
  Future<List<UnifiedMessage>> history(String chatId, {int limit = 50}) async {
    final id = _parseChatId(chatId);
    final messages = await _api.fetchHistory(id, count: limit);
    return [
      for (final m in messages.reversed) mapMessage(_account, m),
    ];
  }

  @override
  Future<SendResult> sendText(String chatId, String text) async {
    final id = _parseChatId(chatId);
    final messageId = await _api.sendMessage(id, text);
    return SendResult(
      messageId: messageId,
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
  }

  @override
  Future<void> sendMedia(String chatId, String filePath) async {
    throw UnsupportedError('MaxBackend.sendMedia: файлы идут через файловый '
        'модуль upstream (Т-1.4 — только текст)');
  }

  @override
  Future<void> editText(String chatId, String messageId, String newText) =>
      _api.editMessage(_parseChatId(chatId), messageId, newText);

  @override
  Future<void> deleteMessages(String chatId, List<String> messageIds) =>
      _api.deleteMessages(_parseChatId(chatId), messageIds);

  @override
  Future<void> setReaction(String chatId, String messageId, String reaction) =>
      _api.setReaction(_parseChatId(chatId), messageId, reaction);

  @override
  Future<void> markRead(String chatId) async {
    final id = _parseChatId(chatId);
    final last = await _api.fetchHistory(id, count: 1);
    if (last.isNotEmpty) {
      await _api.markRead(id, last.first.id);
    }
  }

  @override
  Future<void> setTyping(String chatId, bool typing) =>
      _api.sendTyping(_parseChatId(chatId), typing);

  @override
  Future<void> downloadMedia(String messageId, String targetPath) {
    throw UnsupportedError('MaxBackend.downloadMedia: медиа-модуль upstream '
        'подключается в UI-фазе (Т-1.4 — только контракт)');
  }

  @override
  Future<void> registerPush(String pushToken) =>
      _api.registerPushToken(pushToken);

  @override
  Future<void> unregisterPush(String pushToken) =>
      _api.unregisterPushToken(pushToken);

  /// Ghost mode reuses the upstream «невидимку»: pingInteractive=false и
  /// сервер не видит активность (api.dart: pingInteractive в SessionOptions).
  @override
  Future<void> setGhostMode(bool enabled) async {
    _ghostMode = enabled;
    await _api.setGhostMode(enabled);
    if (!_eventController.isClosed) {
      _eventController.add(BackendEvent(
        kind: BackendEventKind.ghostModeChanged,
        account: _account,
        timestamp: DateTime.now().millisecondsSinceEpoch,
      ));
    }
  }

  bool get isGhostMode => _ghostMode;

  @override
  Future<void> pause() async {
    _requireAlive();
    if (_paused) return;
    _paused = true;
    await _api.disconnect();
  }

  @override
  Future<void> resume() async {
    _requireAlive();
    if (!_paused) return;
    _paused = false;
    await connectAndLogin();
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _pushSub?.cancel();
    await _stateSub?.cancel();
    await _eventController.close();
    await _stateController.close();
    await _api.dispose();
  }

  int _parseChatId(String chatId) {
    if (!chatId.startsWith('c:')) {
      throw FormatException('MaxBackend: не MAX chatId: $chatId');
    }
    final id = int.tryParse(chatId.substring(2));
    if (id == null) {
      throw FormatException('MaxBackend: некорректный chatId: $chatId');
    }
    return id;
  }

  void _requireAlive() {
    if (_disposed) {
      throw StateError('MaxBackend: disposed');
    }
  }
}
