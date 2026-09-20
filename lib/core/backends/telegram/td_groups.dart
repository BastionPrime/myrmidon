/// Groups and channels (plan-v3 Т-2.7): read side — full info of basic
/// groups / supergroups / channels and the current member's status; base
/// rights surfaced as a small view model (member_count, description,
/// can_get_members, slow_mode_delay, invite_link). No admin tooling (plan:
/// «без админ-инструментов»). Shapes follow the master td_api.tl schema
/// (machine-verified by tools/td_schema_check.py):
/// - getBasicGroupFullInfo basic_group_id:int53 = BasicGroupFullInfo;
/// - getSupergroupFullInfo supergroup_id:int53 = SupergroupFullInfo;
/// - getChatMember chat_id:int53 member_id:MessageSender = ChatMember;
/// - chatMember { member_id, tag, inviter_user_id, joined_chat_date,
///   status: ChatMemberStatus };
/// - chatMemberStatus{Creator,Administrator,Member,Restricted,Left} —
///   creator (is_anonymous/is_member), administrator (rights:
///   chatAdministratorRights), member, restricted (permissions:
///   chatPermissions), left/banned.
library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';

/// The chat-side id of a group chat json (chatTypeBasicGroup.basic_group_id
/// / chatTypeSupergroup.supergroup_id), or null for other chat types.
({String kind, int groupId})? tgGroupIdOf(Map<String, dynamic> chat) {
  final type = chat['type'];
  if (type is! Map) return null;
  switch (type['@type']) {
    case 'chatTypeBasicGroup':
      final id = type['basic_group_id'];
      return id is int ? (kind: 'basicGroup', groupId: id) : null;
    case 'chatTypeSupergroup':
      final id = type['supergroup_id'];
      return id is int ? (kind: 'supergroup', groupId: id) : null;
    default:
      return null;
  }
}

/// Read-side view of one group / channel (unified-model friendly,
/// content-free beyond what the UI shows).
class TdGroupInfo {
  final String kind;
  final int groupId;
  final int memberCount;
  final int administratorCount;
  final String description;
  final bool canGetMembers;
  final int slowModeDelaySec;
  final String? inviteLink;

  const TdGroupInfo({
    required this.kind,
    required this.groupId,
    required this.memberCount,
    required this.administratorCount,
    required this.description,
    required this.canGetMembers,
    required this.slowModeDelaySec,
    this.inviteLink,
  });

  bool get isChannel => kind == 'channel';

  static TdGroupInfo? fromFullInfo(String kind, int groupId, Map<String, dynamic> fullInfo) {
    switch (kind) {
      case 'basicGroup':
        final members = fullInfo['members'];
        return TdGroupInfo(
          kind: kind,
          groupId: groupId,
          memberCount: members is List ? members.length : 0,
          administratorCount: 0,
          description: fullInfo['description'] is String
              ? fullInfo['description'] as String
              : '',
          canGetMembers: true,
          slowModeDelaySec: 0,
          inviteLink: fullInfo['invite_link'] is Map
              ? (fullInfo['invite_link'] as Map)['invite_link'] as String?
              : null,
        );
      case 'supergroup':
      case 'channel':
        final memberCount = fullInfo['member_count'];
        final adminCount = fullInfo['administrator_count'];
        final canGetMembers = fullInfo['can_get_members'];
        final slowMode = fullInfo['slow_mode_delay'];
        return TdGroupInfo(
          kind: kind,
          groupId: groupId,
          memberCount: memberCount is int ? memberCount : 0,
          administratorCount: adminCount is int ? adminCount : 0,
          description: fullInfo['description'] is String
              ? fullInfo['description'] as String
              : '',
          canGetMembers: canGetMembers == true,
          slowModeDelaySec: slowMode is int ? slowMode : 0,
          inviteLink: fullInfo['invite_link'] is Map
              ? (fullInfo['invite_link'] as Map)['invite_link'] as String?
              : null,
        );
      default:
        return null;
    }
  }
}

/// The member's own standing in a group: one of the ChatMemberStatus
/// variants mapped to a base-rights triple (plan: «базовые права»).
class TdMemberStanding {
  final String status;
  final bool isMember;
  final bool canSendMessages;
  final bool canInviteUsers;

  const TdMemberStanding({
    required this.status,
    required this.isMember,
    required this.canSendMessages,
    required this.canInviteUsers,
  });

  /// Maps a chatMember.status json to base rights. creator/administrator →
  /// full base rights; member → member defaults; restricted → gated by its
  /// chatPermissions (can_send_messages / can_invite_users_by_link in the
  /// schema); left / banned → nothing.
  static TdMemberStanding? fromChatMember(Map<String, dynamic> chatMember) {
    final status = chatMember['status'];
    if (status is! Map) return null;
    switch (status['@type']) {
      case 'chatMemberStatusCreator':
        return TdMemberStanding(
          status: 'creator',
          isMember: status['is_member'] == true,
          canSendMessages: true,
          canInviteUsers: true,
        );
      case 'chatMemberStatusAdministrator':
        // Administrator base rights: the administrator's own
        // chatAdministratorRights include invite_users; message sending is
        // governed by chat rights — surfaced as true at this base level.
        return TdMemberStanding(
          status: 'administrator',
          isMember: true,
          canSendMessages: true,
          canInviteUsers: true,
        );
      case 'chatMemberStatusMember':
        return TdMemberStanding(
          status: 'member',
          isMember: true,
          canSendMessages: true,
          canInviteUsers: true,
        );
      case 'chatMemberStatusRestricted':
        final permissions = status['permissions'];
        final perm = permissions is Map ? permissions.cast<String, dynamic>() : const <String, dynamic>{};
        return TdMemberStanding(
          status: 'restricted',
          isMember: status['is_member'] == true,
          canSendMessages: perm['can_send_messages'] == true,
          canInviteUsers: perm['can_invite_users_by_link'] == true,
        );
      case 'chatMemberStatusLeft':
        return const TdMemberStanding(
          status: 'left',
          isMember: false,
          canSendMessages: false,
          canInviteUsers: false,
        );
      case 'chatMemberStatusBanned':
        return const TdMemberStanding(
          status: 'banned',
          isMember: false,
          canSendMessages: false,
          canInviteUsers: false,
        );
      default:
        return null;
    }
  }
}

class TdGroups {
  final TdBridge bridge;

  TdGroups({required this.bridge});

  /// Full info of a basic group (member list rides along in the schema).
  Future<Map<String, dynamic>> basicGroupFullInfo(int basicGroupId) =>
      bridge.send({
        '@type': 'getBasicGroupFullInfo',
        'basic_group_id': basicGroupId,
      });

  /// Full info of a supergroup / channel (counts, permissions, slow mode).
  Future<Map<String, dynamic>> supergroupFullInfo(int supergroupId) =>
      bridge.send({
        '@type': 'getSupergroupFullInfo',
        'supergroup_id': supergroupId,
      });

  /// The chatMember of [userId] in [chatId] (getChatMember with
  /// messageSenderUser as the member id).
  Future<Map<String, dynamic>> chatMemberOf(int chatId, int userId) =>
      bridge.send({
        '@type': 'getChatMember',
        'chat_id': chatId,
        'member_id': {
          '@type': 'messageSenderUser',
          'user_id': userId,
        },
      });

  /// Convenience: full info of the group behind a chat json + the
  /// standing of [userId] (read side of Т-2.7).
  Future<TdGroupInfo?> groupInfoOfChat(
    Map<String, dynamic> chat, {
    int? userId,
  }) async {
    final groupKey = tgGroupIdOf(chat);
    if (groupKey == null) return null;
    final Map<String, dynamic> fullInfo;
    switch (groupKey.kind) {
      case 'basicGroup':
        fullInfo = await basicGroupFullInfo(groupKey.groupId);
      case 'supergroup':
        fullInfo = await supergroupFullInfo(groupKey.groupId);
      default:
        return null;
    }
    var info = TdGroupInfo.fromFullInfo(groupKey.kind, groupKey.groupId, fullInfo);
    final isChannel = groupKey.kind == 'supergroup' &&
        (chat['type'] as Map)['is_channel'] == true;
    if (isChannel && info != null) {
      info = TdGroupInfo(
        kind: 'channel',
        groupId: info.groupId,
        memberCount: info.memberCount,
        administratorCount: info.administratorCount,
        description: info.description,
        canGetMembers: info.canGetMembers,
        slowModeDelaySec: info.slowModeDelaySec,
        inviteLink: info.inviteLink,
      );
    }
    return info;
  }

  /// The standing of [userId] in the chat (null when not a group).
  Future<TdMemberStanding?> standingOf(
    Map<String, dynamic> chat,
    int userId,
  ) async {
    if (tgGroupIdOf(chat) == null) return null;
    final chatId = chat['id'];
    if (chatId is! int) return null;
    final member = await chatMemberOf(chatId, userId);
    return TdMemberStanding.fromChatMember(member);
  }
}
