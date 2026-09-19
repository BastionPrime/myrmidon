/// Fake [MaxApiLike] for unit tests of MaxBackend.
library;

import 'dart:async';

import 'package:wellmagram/core/backends/max/max_api_seam.dart';

class FakeMaxApi implements MaxApiLike {
  SessionSpec? lastSpec;
  String? lastLoginToken;
  String? lastPushToken;
  bool? lastGhostMode;
  bool disconnected = false;
  bool disposed = false;
  int disposeCount = 0;
  List<String> sentTexts = [];
  List<(int, String)> sentTyping = [];
  List<String> markedRead = [];

  MaxSessionState state = MaxSessionState.disconnected;
  final _stateController = StreamController<MaxSessionState>.broadcast();
  final _pushController = StreamController<MaxPushPacket>.broadcast();

  List<MaxCachedChat> chats = const [];
  List<MaxCachedMessage> history = const [];
  String nextMessageId = '1000';

  @override
  Future<void> connect({required SessionSpec spec}) async {
    lastSpec = spec;
    state = MaxSessionState.online;
    _stateController.add(state);
  }

  @override
  Future<void> disconnect() async {
    disconnected = true;
    state = MaxSessionState.disconnected;
    _stateController.add(state);
  }

  @override
  Future<void> dispose() async {
    if (disposed) {
      disposeCount++;
      return;
    }
    disposed = true;
    disposeCount = 1;
    await _stateController.close();
    await _pushController.close();
  }

  @override
  Stream<MaxSessionState> get stateStream => _stateController.stream;

  @override
  Stream<MaxPushPacket> get pushStream => _pushController.stream;

  void emitPush(MaxPushPacket packet) => _pushController.add(packet);

  @override
  Future<void> login({required String token}) async {
    lastLoginToken = token;
  }

  @override
  Future<void> registerPushToken(String pushToken) async {
    lastPushToken = pushToken;
  }

  @override
  Future<void> unregisterPushToken(String pushToken) async {
    lastPushToken = null;
  }

  @override
  Future<void> setGhostMode(bool enabled) async {
    lastGhostMode = enabled;
  }

  @override
  Future<List<MaxCachedChat>> getChats() async => chats;

  @override
  Future<List<MaxCachedMessage>> fetchHistory(
    int chatId, {
    int count = 50,
    int? backward,
  }) async =>
      history.take(count).toList();

  @override
  Future<String> sendMessage(int chatId, String text) async {
    sentTexts.add(text);
    return nextMessageId;
  }

  @override
  Future<bool> editMessage(int chatId, String messageId, String text) async =>
      true;

  @override
  Future<bool> deleteMessages(int chatId, List<String> messageIds) async =>
      true;

  @override
  Future<bool> setReaction(int chatId, String messageId, String emoji) async =>
      true;

  @override
  Future<void> markRead(int chatId, String messageId) async {
    markedRead.add('$chatId/$messageId');
  }

  @override
  Future<void> sendTyping(int chatId, bool typing) async {
    sentTyping.add((chatId, typing ? 'TEXT' : 'STOP'));
  }
}
