/// Telegram backend module (plan-v3 4.4 / Фаза 2): TdBridge over the
/// libtdjson seam, authorization flow (Т-2.2) and the database-encryption
/// key store. TelegramBackend chat operations (Т-2.3+) build on TdBridge.
library;

export 'td_auth_flow.dart';
export 'td_bridge.dart';
export 'td_chat_store.dart';
export 'td_client_seam.dart';
export 'td_db_key_store.dart';
export 'td_messages.dart';
