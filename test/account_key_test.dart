import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  test('storageId uses short network names', () {
    final max = const AccountKey(network: Network.max, id: 7);
    final tg = const AccountKey(network: Network.telegram, id: 42);
    expect(max.storageId, 'max:7');
    expect(tg.storageId, 'tg:42');
  });

  test('equality and hashCode by network and id', () {
    const a = AccountKey(network: Network.max, id: 1);
    const b = AccountKey(network: Network.max, id: 1);
    const c = AccountKey(network: Network.telegram, id: 1);
    expect(a == b, isTrue);
    expect(a == c, isFalse);
    expect(a.hashCode, b.hashCode);
  });

  test('compareTo orders by network then id', () {
    const max7 = AccountKey(network: Network.max, id: 7);
    const max8 = AccountKey(network: Network.max, id: 8);
    const tg7 = AccountKey(network: Network.telegram, id: 7);
    expect(max7.compareTo(max8), lessThan(0));
    expect(max8.compareTo(max7), greaterThan(0));
    expect(max7.compareTo(tg7), lessThan(0));
  });

  test('tryParse round-trips valid keys', () {
    final key = AccountKey.tryParse('max:123');
    expect(key, const AccountKey(network: Network.max, id: 123));
    expect(AccountKey.tryParse('tg:456')!.id, 456);
  });

  test('tryParse rejects malformed storage ids', () {
    expect(AccountKey.tryParse('unknown:1'), isNull);
    expect(AccountKey.tryParse('max:notanumber'), isNull);
    expect(AccountKey.tryParse('max:'), isNull);
    expect(AccountKey.tryParse(':7'), isNull);
    expect(AccountKey.tryParse('max'), isNull);
    expect(AccountKey.tryParse('max:0'), isNull);
    expect(AccountKey.tryParse('max:-3'), isNull);
    expect(AccountKey.tryParse(''), isNull);
  });

  test('Network.tryParse accepts only known names', () {
    expect(Network.tryParse('max'), Network.max);
    expect(Network.tryParse('tg'), Network.telegram);
    expect(Network.tryParse('MAX'), isNull);
    expect(Network.tryParse('telegram'), isNull);
    expect(Network.tryParse(''), isNull);
  });
}
