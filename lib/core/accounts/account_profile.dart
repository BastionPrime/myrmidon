/// Non-secret description of a registered account, persisted as JSON in
/// SharedPreferences (S2: no tokens or secrets live here).
library;

import 'account_key.dart';
import 'network.dart';

class AccountProfile implements Comparable<AccountProfile> {
  final AccountKey key;
  final String displayName;
  final String phone;

  /// Milliseconds since epoch of the last registry write.
  final int updatedAt;

  const AccountProfile({
    required this.key,
    required this.displayName,
    required this.phone,
    required this.updatedAt,
  });

  AccountProfile copyWith({String? displayName, String? phone, int? updatedAt}) =>
      AccountProfile(
        key: key,
        displayName: displayName ?? this.displayName,
        phone: phone ?? this.phone,
        updatedAt: updatedAt ?? this.updatedAt,
      );

  @override
  int compareTo(AccountProfile other) => key.compareTo(other.key);

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AccountProfile &&
          other.key == key &&
          other.displayName == displayName &&
          other.phone == phone &&
          other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(key, displayName, phone, updatedAt);

  Map<String, dynamic> toJson() => {
        'network': key.network.storageName,
        'id': key.id,
        'display_name': displayName,
        'phone': phone,
        'updated_at': updatedAt,
      };

  static AccountProfile? fromJson(Map<String, dynamic> json) {
    final network = Network.tryParse(json['network'] as String? ?? '');
    final id = json['id'] as int?;
    if (network == null || id == null || id <= 0) return null;
    return AccountProfile(
      key: AccountKey(network: network, id: id),
      displayName: json['display_name'] as String? ?? '',
      phone: json['phone'] as String? ?? '',
      updatedAt: json['updated_at'] as int? ?? 0,
    );
  }
}
