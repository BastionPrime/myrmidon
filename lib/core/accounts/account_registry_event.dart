/// Change notifications emitted by [AccountRegistry].
library;

import 'account_key.dart';

enum AccountRegistryEventKind { added, removed, updated, activeChanged }

class AccountRegistryEvent {
  final AccountRegistryEventKind kind;
  final AccountKey key;

  const AccountRegistryEvent({required this.kind, required this.key});

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AccountRegistryEvent &&
          other.kind == kind &&
          other.key == key;

  @override
  int get hashCode => Object.hash(kind, key);

  @override
  String toString() => 'AccountRegistryEvent(${kind.name}, $key)';
}
