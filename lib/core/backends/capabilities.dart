/// Backend capability flags (plan-v3 4.3): what a MessengerBackend supports.
///
/// A unified UI renders features by these flags instead of branching on the
/// network, so MAX and Telegram adapters declare the same contract.
library;

import '../accounts/network.dart';

class Capabilities {
  final bool sendText;
  final bool sendMedia;
  final bool editText;
  final bool deleteMessages;
  final bool setReaction;
  final bool markRead;
  final bool setTyping;
  final bool downloadMedia;
  final bool calls;
  final bool pushRegistration;
  final bool ghostMode;

  const Capabilities({
    required this.sendText,
    required this.sendMedia,
    required this.editText,
    required this.deleteMessages,
    required this.setReaction,
    required this.markRead,
    required this.setTyping,
    required this.downloadMedia,
    required this.calls,
    required this.pushRegistration,
    required this.ghostMode,
  });

  /// MAX protocol (upstream Komet modules) supports all listed operations.
  static const Capabilities max = Capabilities(
    sendText: true,
    sendMedia: true,
    editText: true,
    deleteMessages: true,
    setReaction: true,
    markRead: true,
    setTyping: true,
    downloadMedia: true,
    calls: true,
    pushRegistration: true,
    ghostMode: true,
  );

  /// Telegram baseline (TDLib) for Phase 2; media/calls arrive later there.
  static const Capabilities telegram = Capabilities(
    sendText: true,
    sendMedia: false,
    editText: true,
    deleteMessages: true,
    setReaction: true,
    markRead: true,
    setTyping: true,
    downloadMedia: false,
    calls: false,
    pushRegistration: false,
    ghostMode: true,
  );

  static Capabilities forNetwork(Network network) => switch (network) {
        Network.max => max,
        Network.telegram => telegram,
      };
}
