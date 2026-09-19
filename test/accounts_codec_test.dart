import 'dart:convert';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/account_profile.dart';
import 'package:wellmagram/core/accounts/accounts_codec.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

AccountProfile profile(String net, int id, {String name = '', String phone = ''}) =>
    AccountProfile(
      key: AccountKey(network: Network.tryParse(net)!, id: id),
      displayName: name,
      phone: phone,
      updatedAt: 1234567,
    );

void main() {
  test('encode/decode round-trips the snapshot', () {
    final raw = AccountsCodec.encode(
      profiles: [profile('max', 1, name: 'A'), profile('tg', 2, name: 'B')],
      activeKey: const AccountKey(network: Network.telegram, id: 2),
    );
    final decoded = AccountsCodec.decode(raw)!;
    expect(decoded.profiles, hasLength(2));
    expect(decoded.profiles.first.key.storageId, 'max:1');
    expect(decoded.activeKey!.storageId, 'tg:2');
  });

  test('decode returns null for empty and invalid JSON', () {
    expect(AccountsCodec.decode(null), isNull);
    expect(AccountsCodec.decode(''), isNull);
    expect(AccountsCodec.decode('not json'), isNull);
    expect(AccountsCodec.decode('[]'), isNull);
  });

  test('decode rejects snapshots from a newer version', () {
    final raw = jsonEncode({'version': 99, 'accounts': <Object>[]});
    expect(AccountsCodec.decode(raw), isNull);
  });

  test('decode drops unknown networks and bad entries', () {
    final raw = jsonEncode({
      'version': 1,
      'accounts': [
        {'network': 'unknown', 'id': 1},
        {'network': 'max', 'id': 2},
        {'network': 'max'},
        'junk',
      ],
      'active': 'max:2',
    });
    final decoded = AccountsCodec.decode(raw)!;
    expect(decoded.profiles, hasLength(1));
    expect(decoded.profiles.first.key.id, 2);
  });

  test('decode ignores active key missing from profiles', () {
    final raw = jsonEncode({
      'version': 1,
      'accounts': [
        {'network': 'max', 'id': 1},
      ],
      'active': 'tg:9',
    });
    final decoded = AccountsCodec.decode(raw)!;
    expect(decoded.activeKey, isNull);
  });

  test('decoded profiles are sorted by key', () {
    final raw = AccountsCodec.encode(
      profiles: [profile('tg', 5), profile('max', 9), profile('max', 2)],
      activeKey: null,
    );
    final decoded = AccountsCodec.decode(raw)!;
    expect(
      decoded.profiles.map((p) => p.key.storageId).toList(),
      ['max:2', 'max:9', 'tg:5'],
    );
  });

  test('snapshot JSON contains no secret-looking fields', () {
    final raw = AccountsCodec.encode(
      profiles: [
        AccountProfile(
          key: const AccountKey(network: Network.max, id: 1),
          displayName: 'A',
          phone: '+70000000001',
          updatedAt: 1,
        ),
      ],
      activeKey: const AccountKey(network: Network.max, id: 1),
    );
    expect(raw, isNot(contains('token')));
    expect(raw, isNot(contains('secret')));
    expect(raw, isNot(contains('auth_token')));
  });
}
