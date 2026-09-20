library;

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_ghost.dart';

import 'mock_td_client.dart';

void main() {
  group('TdGhostSettings', () {
    test('defaults are all-on, off is all-off, copyWith/== work', () {
      expect(const TdGhostSettings().ghostRead, isTrue);
      expect(const TdGhostSettings().ghostTyping, isTrue);
      expect(const TdGhostSettings().ghostOnline, isTrue);
      expect(TdGhostSettings.off.ghostRead, isFalse);
      final mixed = const TdGhostSettings().copyWith(ghostRead: false);
      expect(mixed.ghostRead, isFalse);
      expect(mixed.ghostTyping, isTrue);
      expect(mixed, isNot(equals(const TdGhostSettings())));
      expect(
        mixed.copyWith(ghostRead: true),
        equals(const TdGhostSettings()),
      );
    });
  });

  group('TdGhost online option', () {
    test('setGhostMode(on) sends setOption online=false', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      final call = ghost.setGhostMode(const TdGhostSettings());
      mock.answerLast();
      await call;
      expect(mock.sentRequests.single['@type'], 'setOption');
      expect(mock.sentRequests.single['name'], 'online');
      expect(
        (mock.sentRequests.single['value'] as Map)['value'],
        isFalse,
      );
      expect((mock.sentRequests.single['value'] as Map)['@type'],
          'optionValueBoolean');
    });

    test('reapplyOnline re-sends the option; no wire call when off', () async {
      final mock = MockTdClient();
      mock.autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      await ghost.setGhostMode(const TdGhostSettings());
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests.single['@type'], 'setOption');
      mock.sentRequests.clear();

      final call = ghost.reapplyOnline();
      mock.answerLast();
      await call;
      expect(mock.sentRequests.single['@type'], 'setOption');

      mock.sentRequests.clear();
      await ghost.setGhostMode(TdGhostSettings.off);
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests.single['@type'], 'setOption');
      expect((mock.sentRequests.single['value'] as Map)['@type'],
          'optionValueEmpty',
          reason: 'ghost off restores auto online via optionValueEmpty');
      mock.sentRequests.clear();
      await ghost.reapplyOnline();
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests, isEmpty,
          reason: 'no re-apply while ghost is off');
    });

    test('setGhostMode with ghostOnline=false from the start sends nothing',
        () async {
      final mock = MockTdClient();
      mock.autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      await ghost.setGhostMode(
        const TdGhostSettings(ghostRead: true, ghostTyping: true, ghostOnline: false),
      );
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests, isEmpty);
      expect(ghost.settings.ghostRead, isTrue);
    });
  });

  group('ghost suppression', () {
    test('markRead / sendTyping are wire-silent in ghost', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      final call = ghost.setGhostMode(const TdGhostSettings());
      mock.answerLast();
      await call;
      mock.sentRequests.clear();

      await ghost.markRead(101, [900, 901]);
      await ghost.sendTyping(
          101, {'@type': 'chatActionTyping'});
      expect(mock.sentRequests, isEmpty,
          reason: 'ghost suppresses openChat/viewMessages/sendChatAction');

      expect(ghost.shouldMarkRead(), isFalse);
      expect(ghost.shouldSendTyping(), isFalse);
    });

    test('ghost off: markRead sends openChat+viewMessages, typing sends sendChatAction',
        () async {
      final mock = MockTdClient();
      mock.autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      expect(ghost.settings, equals(TdGhostSettings.off),
          reason: 'ghost starts off until applied');
      await ghost.setGhostMode(TdGhostSettings.off);
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests, isEmpty,
          reason: 'off -> off transition sends nothing');

      await ghost.markRead(101, [900]);
      expect(mock.sentRequests.length, 2);
      expect(mock.sentRequests[0]['@type'], 'openChat');
      expect(mock.sentRequests[1]['@type'], 'viewMessages');
      expect(mock.sentRequests[1]['chat_id'], 101);
      expect(mock.sentRequests[1]['message_ids'], [900]);
      expect(mock.sentRequests[1]['force_read'], isTrue);

      await ghost.sendTyping(101, {'@type': 'chatActionTyping'});
      expect(mock.sentRequests[2]['@type'], 'sendChatAction');
      expect(mock.sentRequests[2]['action'],
          equals({'@type': 'chatActionTyping'}));
      expect(mock.sentRequests[2].containsKey('topic_id'), isFalse,
          reason: 'optional fields omitted, not nulled');
      expect(ghost.shouldMarkRead(), isTrue);
      expect(ghost.shouldSendTyping(), isTrue);
    });

    test('per-axis ghost: read ghosted, typing live', () async {
      final mock = MockTdClient();
      mock.autoAnswer = true;
      final bridge = TdBridge(client: mock);
      final ghost = TdGhost(bridge: bridge);
      await ghost.setGhostMode(
        const TdGhostSettings(ghostRead: true, ghostTyping: false, ghostOnline: false),
      );
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests, isEmpty);

      await ghost.markRead(1, [1]);
      await Future<void>.delayed(Duration.zero);
      expect(mock.sentRequests, isEmpty);
      await ghost.sendTyping(1, {'@type': 'chatActionTyping'});
      expect(mock.sentRequests.single['@type'], 'sendChatAction');
    });
  });

  group('request shapes', () {
    test('viewMessages/openChat/sendChatAction builders match schema', () {
      final mock = MockTdClient();
      final ghost = TdGhost(bridge: TdBridge(client: mock));

      final view = ghost.viewMessagesRequest(7, [1, 2]);
      expect(view['@type'], 'viewMessages');
      expect(view['chat_id'], 7);
      expect(view['message_ids'], [1, 2]);
      expect(view['force_read'], isTrue);
      expect(view.keys.toSet(), {'@type', 'chat_id', 'message_ids', 'force_read'});

      final open = ghost.openChatRequest(7);
      expect(open, equals({'@type': 'openChat', 'chat_id': 7}));

      final action = ghost.sendChatActionRequest(7, {'@type': 'chatActionCancel'});
      expect(action['@type'], 'sendChatAction');
      expect(action['chat_id'], 7);
      expect(action['action'], equals({'@type': 'chatActionCancel'}));
      expect(action.keys.toSet(), {'@type', 'chat_id', 'action'});
    });
  });

  group('backend contract alignment', () {
    test('messenger_backend.setGhostMode(bool) maps onto TdGhost profile', () {
      // The unified contract (messenger_backend.dart:64) takes a bool; the
      // Telegram profile for `enabled=true` is the all-on default and for
      // `false` TdGhostSettings.off — same semantics as MAX (max_backend
      // .dart:162-172): setting flags + event emission are the backend's
      // job, the seam owns the wire policy.
      const enabled = TdGhostSettings();
      const disabled = TdGhostSettings.off;
      expect(enabled, isNot(equals(disabled)));
      expect(enabled.ghostRead && enabled.ghostTyping && enabled.ghostOnline,
          isTrue);
      expect(
          disabled.ghostRead || disabled.ghostTyping || disabled.ghostOnline,
          isFalse);
    });
  });
}
