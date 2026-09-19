import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/backends/capabilities.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  test('max capabilities are fully enabled', () {
    const c = Capabilities.max;
    expect(c.sendText, isTrue);
    expect(c.sendMedia, isTrue);
    expect(c.editText, isTrue);
    expect(c.deleteMessages, isTrue);
    expect(c.setReaction, isTrue);
    expect(c.markRead, isTrue);
    expect(c.setTyping, isTrue);
    expect(c.downloadMedia, isTrue);
    expect(c.calls, isTrue);
    expect(c.pushRegistration, isTrue);
    expect(c.ghostMode, isTrue);
  });

  test('telegram baseline is text-first', () {
    const c = Capabilities.telegram;
    expect(c.sendText, isTrue);
    expect(c.sendMedia, isFalse);
    expect(c.calls, isFalse);
    expect(c.pushRegistration, isFalse);
    expect(c.ghostMode, isTrue);
  });

  test('forNetwork maps networks to their presets', () {
    expect(Capabilities.forNetwork(Network.max), same(Capabilities.max));
    expect(Capabilities.forNetwork(Network.telegram), same(Capabilities.telegram));
  });

  test('networks have distinct capability sets', () {
    const max = AccountKey(network: Network.max, id: 1);
    expect(Capabilities.forNetwork(max.network).calls, isTrue);
    expect(Capabilities.forNetwork(Network.telegram).calls, isFalse);
  });
}
