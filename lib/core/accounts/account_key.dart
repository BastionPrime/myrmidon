/// Immutable identity of one messenger account inside wellmagram.
///
/// A key is (network, id): MAX accounts are identified by their server-side
/// numeric id, Telegram accounts by their user id. The string form is used in
/// storage keys (prefs, secure storage, per-account database names).
library;

import 'network.dart';

class AccountKey implements Comparable<AccountKey> {
  final Network network;
  final int id;

  const AccountKey({required this.network, required this.id});

  /// Stable storage form: `max:123`, `tg:456`.
  String get storageId => '${network.storageName}:$id';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AccountKey && other.network == network && other.id == id;

  @override
  int get hashCode => Object.hash(network, id);

  @override
  int compareTo(AccountKey other) {
    final byNetwork = network.index.compareTo(other.network.index);
    if (byNetwork != 0) return byNetwork;
    return id.compareTo(other.id);
  }

  @override
  String toString() => 'AccountKey($storageId)';

  static AccountKey? tryParse(String raw) {
    final colon = raw.indexOf(':');
    if (colon <= 0 || colon == raw.length - 1) return null;
    final network = Network.tryParse(raw.substring(0, colon));
    if (network == null) return null;
    final id = int.tryParse(raw.substring(colon + 1));
    if (id == null || id <= 0) return null;
    return AccountKey(network: network, id: id);
  }
}
