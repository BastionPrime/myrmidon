library;

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_groups.dart';

import 'mock_td_client.dart';

Map<String, dynamic> groupChat({
  required int chatId,
  String type = 'chatTypeSupergroup',
  int? groupId,
  bool isChannel = false,
}) =>
    {
      '@type': 'chat',
      'id': chatId,
      'type': {
        '@type': type,
        if (type == 'chatTypeSupergroup') ...{
          'supergroup_id': groupId ?? 501,
          'is_channel': isChannel,
        },
        if (type == 'chatTypeBasicGroup') 'basic_group_id': groupId ?? 601,
      },
      'title': 'Group',
    };

void main() {
  group('tgGroupIdOf', () {
    test('extracts basic_group_id / supergroup_id, kinds split', () {
      expect(tgGroupIdOf(groupChat(chatId: 1, type: 'chatTypeBasicGroup'))?.groupId, 601);
      expect(tgGroupIdOf(groupChat(chatId: 1, type: 'chatTypeBasicGroup'))?.kind, 'basicGroup');
      expect(tgGroupIdOf(groupChat(chatId: 1))?.groupId, 501);
      expect(tgGroupIdOf(groupChat(chatId: 1))?.kind, 'supergroup');
    });

    test('non-group or broken chat → null', () {
      expect(
        tgGroupIdOf({
          'type': {'@type': 'chatTypePrivate'},
        }),
        isNull,
      );
      expect(
        tgGroupIdOf({
          'type': {'@type': 'chatTypeSupergroup', 'supergroup_id': 'x'},
        }),
        isNull,
      );
      expect(tgGroupIdOf({'type': null}), isNull);
    });
  });

  group('TdGroups requests', () {
    test('getBasicGroupFullInfo / getSupergroupFullInfo / getChatMember',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final groups = TdGroups(bridge: bridge);

      final basicCall = groups.basicGroupFullInfo(601);
      mock.answerLast({
        '@type': 'basicGroupFullInfo',
        'description': 'd',
        'members': [
          {'@type': 'chatMember'},
          {'@type': 'chatMember'},
        ],
      });
      await basicCall;
      expect(mock.sentRequests[0]['@type'], 'getBasicGroupFullInfo');
      expect(mock.sentRequests[0]['basic_group_id'], 601);

      final superCall = groups.supergroupFullInfo(501);
      mock.answerLast({
        '@type': 'supergroupFullInfo',
        'member_count': 120,
        'administrator_count': 3,
        'description': 'канал',
        'can_get_members': false,
        'slow_mode_delay': 30,
      });
      await superCall;
      expect(mock.sentRequests[1]['@type'], 'getSupergroupFullInfo');
      expect(mock.sentRequests[1]['supergroup_id'], 501);

      final memberCall = groups.chatMemberOf(101, 7717);
      mock.answerLast({
        '@type': 'chatMember',
        'member_id': {'@type': 'messageSenderUser', 'user_id': 7717},
        'status': {'@type': 'chatMemberStatusMember', 'member_until_date': 0},
      });
      await memberCall;
      final request = mock.sentRequests[2];
      expect(request['@type'], 'getChatMember');
      expect(request['chat_id'], 101);
      final memberId = request['member_id'] as Map;
      expect(memberId['@type'], 'messageSenderUser');
      expect(memberId['user_id'], 7717);
    });
  });

  group('TdGroupInfo.fromFullInfo', () {
    test('basic group counts members from the vector', () {
      final info = TdGroupInfo.fromFullInfo('basicGroup', 601, {
        '@type': 'basicGroupFullInfo',
        'description': 'описание',
        'members': List.generate(7, (_) => {'@type': 'chatMember'}),
        'invite_link': {
          '@type': 'chatInviteLink',
          'invite_link': 'https://t.me/+example',
        },
      });
      expect(info?.kind, 'basicGroup');
      expect(info?.memberCount, 7);
      expect(info?.description, 'описание');
      expect(info?.inviteLink, 'https://t.me/+example');
      expect(info?.isChannel, isFalse);
    });

    test('supergroup counts / flags map from full info', () {
      final info = TdGroupInfo.fromFullInfo('supergroup', 501, {
        '@type': 'supergroupFullInfo',
        'member_count': 500,
        'administrator_count': 4,
        'description': '',
        'can_get_members': false,
        'slow_mode_delay': 60,
      });
      expect(info?.memberCount, 500);
      expect(info?.administratorCount, 4);
      expect(info?.canGetMembers, isFalse);
      expect(info?.slowModeDelaySec, 60);
      expect(info?.inviteLink, isNull);
    });

    test('unknown kind → null', () {
      expect(TdGroupInfo.fromFullInfo('private', 1, {}), isNull);
    });
  });

  group('TdMemberStanding.fromChatMember', () {
    test('creator / administrator / member all carry base rights', () {
      for (final statusType in [
        'chatMemberStatusCreator',
        'chatMemberStatusAdministrator',
        'chatMemberStatusMember',
      ]) {
        final standing = TdMemberStanding.fromChatMember({
          'status': {'@type': statusType},
        });
        expect(standing, isNotNull, reason: statusType);
        expect(standing?.canSendMessages, isTrue, reason: statusType);
        expect(standing?.canInviteUsers, isTrue, reason: statusType);
      }
    });

    test('restricted gates on chatPermissions (schema names)', () {
      final standing = TdMemberStanding.fromChatMember({
        'status': {
          '@type': 'chatMemberStatusRestricted',
          'is_member': true,
          'permissions': {
            '@type': 'chatPermissions',
            'can_send_basic_messages': false,
            'can_invite_users': true,
          },
        },
      });
      expect(standing?.status, 'restricted');
      expect(standing?.isMember, isTrue);
      expect(standing?.canSendMessages, isFalse);
      expect(standing?.canInviteUsers, isTrue);
    });

    test('legacy field names do NOT open the restricted gate', () {
      // td_schema_check: NEGATIVE_FIXTURE — the names below are
      // deliberately wrong (legacy / invented) so the shield must NOT
      // count them; the test asserts they never open the gate.
      final standing = TdMemberStanding.fromChatMember({
        'status': {
          '@type': 'chatMemberStatusRestricted',
          'is_member': true,
          'permissions': {
            '@type': 'chatPermissions',
            'can_send_messages': true,
            'can_invite_users_by_link': true,
          },
        },
      });
      expect(standing?.status, 'restricted');
      expect(standing?.isMember, isTrue);
      expect(standing?.canSendMessages, isFalse, reason: 'legacy can_send_messages must not open the gate');
      expect(standing?.canInviteUsers, isFalse, reason: 'invented can_invite_users_by_link must not open the gate');
    });

    test('left / banned / broken → no rights or null', () {
      final left = TdMemberStanding.fromChatMember({
        'status': {'@type': 'chatMemberStatusLeft'},
      });
      expect(left?.status, 'left');
      expect(left?.canSendMessages, isFalse);
      final banned = TdMemberStanding.fromChatMember({
        'status': {'@type': 'chatMemberStatusBanned'},
      });
      expect(banned?.status, 'banned');
      expect(TdMemberStanding.fromChatMember({'status': null}), isNull);
      expect(
        TdMemberStanding.fromChatMember({
          'status': {'@type': 'chatMemberStatusFuture'},
        }),
        isNull,
      );
    });
  });

  group('TdGroups.groupInfoOfChat / standingOf', () {
    test('supergroup chat resolves full info; channel flag honored',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final groups = TdGroups(bridge: bridge);

      final future = groups.groupInfoOfChat(groupChat(chatId: 101, isChannel: true));
      await Future<void>.delayed(Duration.zero);
      mock.answerLast({
        '@type': 'supergroupFullInfo',
        'member_count': 42,
        'administrator_count': 1,
        'can_get_members': true,
        'slow_mode_delay': 0,
        'description': '',
      });
      final info = await future;
      expect(info?.kind, 'channel');
      expect(info?.groupId, 501);
      expect(info?.memberCount, 42);
      expect(info?.isChannel, isTrue);
    });

    test('basic group chat resolves member count', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final groups = TdGroups(bridge: bridge);

      final future =
          groups.groupInfoOfChat(groupChat(chatId: 102, type: 'chatTypeBasicGroup'));
      await Future<void>.delayed(Duration.zero);
      mock.answerLast({
        '@type': 'basicGroupFullInfo',
        'members': List.generate(3, (_) => {'@type': 'chatMember'}),
        'description': '',
      });
      final info = await future;
      expect(info?.kind, 'basicGroup');
      expect(info?.memberCount, 3);
    });

    test('non-group chat → null (both helpers)', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final groups = TdGroups(bridge: bridge);
      final privateChat = {
        '@type': 'chat',
        'id': 5,
        'type': {'@type': 'chatTypePrivate'},
      };
      expect(await groups.groupInfoOfChat(privateChat), isNull);
      expect(await groups.standingOf(privateChat, 7717), isNull);
    });

    test('standingOf maps the member status', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final groups = TdGroups(bridge: bridge);

      final future = groups.standingOf(groupChat(chatId: 101), 7717);
      await Future<void>.delayed(Duration.zero);
      mock.answerLast({
        '@type': 'chatMember',
        'status': {'@type': 'chatMemberStatusMember'},
      });
      final standing = await future;
      expect(standing?.status, 'member');
      expect(standing?.isMember, isTrue);
    });
  });
}
