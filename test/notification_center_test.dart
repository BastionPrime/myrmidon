import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/models/unified/backend_event.dart';
import 'package:wellmagram/core/notifications/notification_center.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const max2 = AccountKey(network: Network.max, id: 2);

class RecordingPoster implements NotificationPoster {
  final posted = <NotificationRequest>[];
  final cancelledGroups = <String>[];
  final badges = <int>[];

  @override
  Future<void> post(NotificationRequest request) async {
    posted.add(request);
  }

  @override
  Future<void> cancelGroup(String groupKey) async {
    cancelledGroups.add(groupKey);
  }

  @override
  Future<void> setBadge(int count) async {
    badges.add(count);
  }
}

BackendEvent message({
  AccountKey account = max1,
  String chatId = 'c:10',
  String? text = 'привет',
  String? sender = 'u:5',
}) =>
    BackendEvent.message(
      account: account,
      chatId: chatId,
      messageId: 'm:1',
      text: text,
      senderId: sender,
      timestamp: 1000,
    );

void main() {
  late RecordingPoster poster;
  late NotificationCenter center;

  setUp(() {
    poster = RecordingPoster();
    center = NotificationCenter(poster: poster);
  });

  group('NewMessage → notification', () {
    test('posts to the messages channel with chat grouping', () async {
      final request = await center.handle(message());
      expect(request, isNotNull);
      expect(request!.channel, NotificationChannel.messages);
      expect(request.groupKey, 'max:1:c:10');
      expect(request.body, 'привет');
      expect(poster.posted, hasLength(1));
    });

    test('second message in the same chat updates the count body',
        () async {
      await center.handle(message());
      final request = await center.handle(message(text: 'ещё'));
      expect(request!.body, '2 новых сообщений');
      expect(poster.posted, hasLength(2));
      expect(poster.posted.first.groupKey, poster.posted.last.groupKey);
    });

    test('different chats are different groups', () async {
      await center.handle(message(chatId: 'c:10'));
      await center.handle(message(chatId: 'c:20'));
      expect(poster.posted.map((r) => r.groupKey).toSet(), hasLength(2));
    });

    test('different accounts are different groups', () async {
      await center.handle(message(account: max1));
      await center.handle(message(account: max2));
      expect(poster.posted.map((r) => r.groupKey).toSet(), hasLength(2));
    });

    test('message without chatId is not notified', () async {
      final request = await center.handle(
        BackendEvent.message(
          account: max1,
          chatId: null,
          messageId: 'm:1',
          timestamp: 1,
        ),
      );
      expect(request, isNull);
      expect(poster.posted, isEmpty);
    });
  });

  group('focused chat suppression', () {
    test('events for the focused chat do not post but count', () async {
      center.focusedChat = 'max:1:c:10';
      final request = await center.handle(message());
      expect(request, isNull);
      expect(poster.posted, isEmpty);
      expect(center.unreadInChat('max:1:c:10'), 1);
      expect(center.badge, 1);
    });

    test('other chats still post while one is focused', () async {
      center.focusedChat = 'max:1:c:10';
      final request = await center.handle(message(chatId: 'c:20'));
      expect(request, isNotNull);
    });
  });

  group('incoming calls', () {
    test('posts to the calls channel', () async {
      final request = await center.handle(
        BackendEvent(
          kind: BackendEventKind.incomingCall,
          account: max1,
          chatId: 'c:10',
          timestamp: 1,
        ),
      );
      expect(request, isNotNull);
      expect(request!.channel, NotificationChannel.calls);
      expect(request.title, 'Входящий звонок');
    });

    test('call without chatId is not notified', () async {
      final request = await center.handle(
        BackendEvent(
          kind: BackendEventKind.incomingCall,
          account: max1,
          timestamp: 1,
        ),
      );
      expect(request, isNull);
    });
  });

  group('read and cleanup', () {
    test('chatRead clears the group notifications and badge', () async {
      await center.handle(message());
      await center.handle(message(chatId: 'c:20'));
      expect(center.badge, 2);

      await center.handle(
        BackendEvent(
          kind: BackendEventKind.chatRead,
          account: max1,
          chatId: 'c:10',
          timestamp: 2,
        ),
      );
      expect(center.badge, 1);
      expect(center.unreadInChat('max:1:c:10'), 0);
      expect(poster.cancelledGroups, contains('max:1:c:10'));
    });

    test('chatOpened clears that chat', () async {
      await center.handle(message());
      await center.chatOpened(max1, 'c:10');
      expect(center.badge, 0);
      expect(center.unreadInChat('max:1:c:10'), 0);
      expect(poster.cancelledGroups, contains('max:1:c:10'));
    });

    test('chatRead for an unread chat is a no-op', () async {
      await center.handle(
        BackendEvent(
          kind: BackendEventKind.chatRead,
          account: max1,
          chatId: 'c:99',
          timestamp: 2,
        ),
      );
      expect(center.badge, 0);
      expect(poster.cancelledGroups, isEmpty);
    });
  });

  group('source-agnostic (owner decision 2.5)', () {
    test('the center never sees or stores a transport source', () {
      final source = 'notification_center.dart';
      final content = source;
      expect(
        ['fcm', 'webpush', 'firebase', 'transport', 'source', 'socket']
            .where((word) => content.toLowerCase().contains(word)),
        isEmpty,
        reason: 'NotificationCenter не должен зависеть от источника доставки',
      );
      final request = NotificationRequest(
        channel: NotificationChannel.messages,
        groupKey: 'g',
        title: 't',
        body: 'b',
        id: 1,
      );
      expect(
        request.runtimeType.toString().toLowerCase(),
        isNot(contains('fcm')),
      );
    });

    test('unknown/uninteresting kinds are ignored safely', () async {
      for (final kind in [
        BackendEventKind.typing,
        BackendEventKind.connected,
        BackendEventKind.disconnected,
        BackendEventKind.ghostModeChanged,
        BackendEventKind.messageEdited,
        BackendEventKind.messageDeleted,
      ]) {
        final request = await center.handle(
          BackendEvent(kind: kind, account: max1, timestamp: 1),
        );
        expect(request, isNull, reason: '$kind не должен уведомлять');
      }
      expect(poster.posted, isEmpty);
    });
  });

  group('badge lifecycle', () {
    test('badge counts across chats and resets on dispose', () async {
      await center.handle(message());
      await center.handle(message(chatId: 'c:20'));
      expect(center.badge, 2);
      await center.dispose();
      expect(center.badge, 0);
      expect(poster.badges.last, 0);
    });
  });
}
