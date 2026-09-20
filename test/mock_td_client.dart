/// In-memory mock of [TdClientLike] for unit tests (plan-v3 Т-2.1).
///
/// Scripts the key 4.4 updates: updateAuthorizationState, updateNewMessage,
/// updateChatLastMessage, updateChatPosition, updateChatReadInbox/Outbox,
/// updateChatUnreadMentionCount, updateUser, updateChatTitle, updateChatPhoto,
/// updateFile, updateConnectionState, updateChatAction, updateUserStatus,
/// updateMessageContent, updateDeleteMessages. Also models the plain
/// request/response flow (ok/error/timeout) so the bridge's `@extra`
/// machinery is exercised end to end.
library;

import 'dart:async';

import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';

class MockTdClient implements TdClientLike {
  /// Requests received via [send], in order (with the bridge-assigned
  /// `@extra` still inside).
  final List<Map<String, dynamic>> sentRequests = [];

  /// Execute requests received, in order.
  final List<Map<String, dynamic>> executeRequests = [];

  /// Update objects queued via [emitUpdate] — delivered on [updateStream]
  /// asynchronously, preserving order.
  final _updateQueue = <Map<String, dynamic>>[];
  final _updateController = StreamController<TdResponse>.broadcast();
  bool _draining = false;
  bool _destroyed = false;

  /// Simulates a broken receive loop: [updateStream] closes without
  /// destroy — the bridge must apply its reconnect policy.
  bool feedBroken = false;

  /// Emits one update to the stream, preserving order.
  void emitUpdate(Map<String, dynamic> update) {
    _updateQueue.add(update);
    _drain();
  }

  /// Emits the whole 4.4 scripted sequence at once.
  void emitKeyUpdates() {
    for (final u in _keyUpdateScript) {
      emitUpdate(u);
    }
  }

  /// Answers the request with the given `@extra` with a result object.
  void answer(String extra, Map<String, dynamic> result) {
    _updateQueue.add({...result, '@extra': extra});
    _drain();
  }

  /// Answers the request with a TDLib error object.
  void answerError(String extra, int code, String message) {
    answer(extra, {'@type': 'error', 'code': code, 'message': message});
  }

  @override
  void send(Map<String, dynamic> request) {
    if (_destroyed) throw StateError('MockTdClient: destroyed');
    sentRequests.add(request);
  }

  @override
  TdResponse? execute(Map<String, dynamic> request) {
    if (_destroyed) throw StateError('MockTdClient: destroyed');
    executeRequests.add(request);
    return TdResponse({'@type': 'ok'});
  }

  @override
  Stream<TdResponse> get updateStream {
    if (_destroyed) return const Stream.empty();
    return _updateController.stream;
  }

  @override
  Future<void> destroy() async {
    if (_destroyed) return;
    _destroyed = true;
    await _updateController.close();
  }

  void _drain() {
    if (_draining || _updateQueue.isEmpty || _updateController.isClosed) return;
    _draining = true;
    Future<void>(() {
      while (_updateQueue.isNotEmpty && !_updateController.isClosed) {
        if (feedBroken) break;
        final next = _updateQueue.removeAt(0);
        _updateController.add(TdResponse(next));
      }
      if (feedBroken && !_updateController.isClosed) {
        _updateController.close();
      }
    }).whenComplete(() {
      _draining = false;
      if (_updateQueue.isNotEmpty && !feedBroken) {
        _drain();
      }
    });
  }
}

/// The update objects from plan 4.4 «апдейты, которые обязательно
/// обрабатывать» — minimal but shape-faithful (real field names of the
/// TDLib json api; ids are synthetic 64-bit-safe numbers).
const List<Map<String, dynamic>> _keyUpdateScript = [
  {
    '@type': 'updateAuthorizationState',
    'authorization_state': {
      '@type': 'authorizationStateWaitTdlibParameters',
    },
  },
  {
    '@type': 'updateAuthorizationState',
    'authorization_state': {'@type': 'authorizationStateWaitEncryptionKey'},
  },
  {
    '@type': 'updateConnectionState',
    'state': {'@type': 'connectionStateReady'},
  },
  {
    '@type': 'updateUser',
    'user': {
      'id': 7717,
      'first_name': 'A',
      'last_name': 'B',
      'username': 'ab',
      'type': {'@type': 'userTypeRegular'},
      'is_bot': false,
    },
  },
  {
    '@type': 'updateUserStatus',
    'user_id': 7717,
    'status': {'@type': 'userStatusOnline'},
  },
  {
    '@type': 'updateNewMessage',
    'message': {
      'id': 531,
      'chat_id': 101,
      'sender_id': {'@type': 'messageSenderUser', 'user_id': 7717},
      'content': {
        '@type': 'messageText',
        'text': {'@type': 'formattedText', 'text': '…'},
      },
      'date': 1758381000,
      'is_outgoing': false,
    },
  },
  {
    '@type': 'updateChatLastMessage',
    'chat_id': 101,
    'last_message': {'id': 531, 'chat_id': 101},
    'order': '778',
  },
  {
    '@type': 'updateChatPosition',
    'chat_id': 101,
    'position': {
      'list': {'@type': 'chatListMain'},
      'order': '778',
    },
    'is_pinned': false,
  },
  {
    '@type': 'updateChatReadInbox',
    'chat_id': 101,
    'last_read_inbox_message_id': 531,
    'unread_count': 2,
  },
  {
    '@type': 'updateChatReadOutbox',
    'chat_id': 101,
    'last_read_outbox_message_id': 530,
  },
  {
    '@type': 'updateChatUnreadMentionCount',
    'chat_id': 101,
    'unread_unmentioned_count': 0,
  },
  {
    '@type': 'updateChatTitle',
    'chat_id': 101,
    'title': 'Ab',
  },
  {
    '@type': 'updateChatAction',
    'chat_id': 101,
    'sender_id': {'@type': 'messageSenderUser', 'user_id': 7717},
    'action': {'@type': 'chatActionTyping'},
  },
  {
    '@type': 'updateFile',
    'file': {'id': 17, 'local': {'is_downloading_completed': false}},
  },
  {
    '@type': 'updateMessageContent',
    'chat_id':  101,
    'message_id': 530,
    'new_content': {
      '@type': 'messageText',
      'text': {'@type': 'formattedText', 'text': '…'},
    },
  },
  {
    '@type': 'updateDeleteMessages',
    'chat_id': 101,
    'message_ids': [529],
    'is_permanent': true,
  },
];
