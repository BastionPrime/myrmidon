/// Supported messenger networks.
library;

enum Network {
  max,
  telegram;

  /// Name used in storage keys (`max`, `tg`) and credential namespaces.
  String get storageName => this == Network.max ? 'max' : 'tg';

  static Network? tryParse(String raw) {
    return switch (raw) {
      'max' => Network.max,
      'tg' => Network.telegram,
      _ => null,
    };
  }
}
