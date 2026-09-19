# OPE-2270 — сверка плана v2 с текущим кодом (по решению владельца п.3)
Дата: 2026-09-19. Исполнитель: adm-dev-lead. Метод: чтение кода, не «документ с документом».
Источники: Komet main 1ae0731 (2026-09-11, shallow clone /srv/dev/research/komet-main),
Kolibri a6cdce9 (2026-08-21, /srv/dev/research/kolibri), plan v2 из тикета OPE-2270.

## Резюме для переписывания плана
План v2 описывает архитектуру, которой больше нет: Dart-транспорт с `connection.dart`,
`onBadCertificate` и `proxy_connector.dart` заменён Rust-ядром kolibri (pub-пакет `kolibri: ^0.1.4`,
flutter_rust_bridge 2.12.0, cargokit). Все задачи, завязанные на Dart-транспорт, переезжают в Rust
или снимаются. Формат кадра и опкоды в целом совпадают (kolibri opcodes.rs явно сгенерирован из
opcode_map.dart), хост — api2.oneme.ru, появились новые слои: webpush (wss://api.oneme.ru/websocket,
web-push подписки через Opcode.config), digital-id (ext-api.max.ru, digital-id.max.ru).

## Пункт за пунктом (по списку владельца)

### 1. Раздел 3.1: пути lib/core/transport/*, connection.dart, tls_config.dart
- `lib/core/transport/`: осталось 4 файла — dispatcher.dart (сейчас диспетчер запросов над kolibri-сессией),
  tls_config.dart (тонкая обёртка: applyMincifryTrust / isInsecureAllowed читают SharedPreferences),
  traffic_monitor.dart, vpn_bypass.dart (148 строк, привязка сокета… — проверять отдельно, см. п.4).
  Файлов connection/sender/receiver/proxy_connector.dart НЕТ — транспорт в Rust:
  kolibri-net/src/transport/{client,tls,proxy,dispatcher,error,wiretap}.rs.
- Транспортный стек Rust: rustls (ClientConfig, tokio_rustls), не SecureSocket/onBadCertificate.
- Проксирование: kolibri transport/proxy.rs поддерживает http/socks5/socks5h с auth
  (`scheme://[user:pass@]host:port`), и `SessionOptions.proxy` прокидывается из Dart
  (api.dart: _buildProxyUrl → openSessionWithWireLog). Дарт-side ProxyConnector не нужен —
  настройка прокси теперь поле SessionOptions.
- ВАЖНО: vpn_bypass.dart остаётся в Dart — проверить его эффективность к Rust-сокетам (сокеты
  открывает Rust; bind-to-interface из Dart может больше не работать). Задача Т-0.x: пересмотреть
  VPN bypass как опцию kolibri (bind_interface в SessionOptions) — сейчас её в SessionOptions НЕТ.

### 2. S6 и Т-5.2 (dev_tls_insecure / onBadCertificate)
- Аналог найден: `TlsConfig.isInsecureAllowed()` (Dart, prefs key `dev_tls_insecure`) →
  `SessionOptions.insecureTls` (api.dart:495,518) → Rust `build_client_config(insecure: true)` →
  `dangerous().with_custom_certificate_verifier(AcceptAnyCert)` (tls.rs:57-67, «DEBUG ONLY, wide
  open to MitM»).
- Компиляционной гарантии НЕТ: kDebugMode/kReleaseMode-гейтов в api.dart/tls_config.dart не найдено
  (grep пуст). Равно как нет гейта и на стороне Rust.
- Переписать Т-5.2: гейт должен жить в Rust-ядре (например, feature/compile-time константа в
  kolibri-net) + Dart-сторона снимается; тест — unit-тест на колибри: в release-конфигурации
  insecureTls=true игнорируется/паникует. Отдельная задача в Фазу 5 (Rust).

### 3. Т-5.3 SPKI-пиннинг
- TLS-рукопожатие целиком в Rust (tls.rs). SPKI-пиннинг делается там: расширение
  `ServerCertVerifier` в kolibri-net (кастомный верификатор с набором SPKI-пинов, «мягкий» режим
  по плану). Dart-часть задачи снимается. Место: kolibri-net/src/transport/tls.rs, рядом
  AcceptAnyCert и root_store().
- Обратить внимание: уже есть встроенный anchor-механизм — Минцифры CA (MINCIFRY_CA_PEM, Rust
  include_str, TRUST_MINCIFRY AtomicBool, setTrustMincifryCa из Dart). Это не пиннинг, но та же
  зона кода; пиннинг должен сосуществовать с минцифры-трастом.

### 4. Раздел 3.2 и SECURITY.md: хост API, белый список S1
- Актуальный хост: `api2.oneme.ru:443` (lib/core/config/config.dart:4; ServerConfig.loadEndpoint
  позволяет override через prefs `server_host_override`).
- Полный список хостов, найденный в коде (кандидаты в S1-whitelist, финально — по E6-аудиту):
  api2.oneme.ru (API), api.oneme.ru + web.max.ru (webpush wss-эндпоинт wss://api.oneme.ru/websocket),
  su.oneme.ru (media upload), digital-id.max.ru и ext-api.max.ru (модуль digital_id — НОВЫЙ,
  в плане отсутствует), legal.max.ru/www.max.ru/max.ru (l10n-тексты, ссылки, call_link —
  статические URL, не сетевые клиенты). Медиа-хосты должны быть подтверждены E6 (в коде URL
  медиа приходит от сервера, фиксированного списка нет).
- SECURITY.md: начать с этого списка + webpush wss + digital-id; S1-инвариант переписать под него.

### 5. Пуши: путь registerPushToken → Opcode.config
- Подтверждён, путь жив: push_service.dart → Firebase.initializeApp() → FirebaseMessaging.getToken()
  → AccountModule.registerPushToken → PrivacyModule.registerPushToken (opcode config=22, payload
  `{'pushToken': token, 'pushOptions': 0}` — privacy_module.dart:78-92; unregisterPushToken тоже есть).
- Opcode жив в Dart (opcode_map.dart, сгенерированный отражение kolibri opcodes.rs) — «где теперь
  живёт Opcode»: в двух местах, синхронизированных руками (kolibri opcodes.rs шапка: «from
  lib/core/protocol/opcode_map.dart»). Опкоды из плана: ping=1, sessionInit=6, authRequest=17,
  auth=18 (проверка кода), login=19, sync=21 (план писал «19 sync» — неверно: 19=login, 21=sync),
  config=22; облачный пароль = authLoginCheckPassword=115 (в плане «115 облачный пароль» —
  фактически это authLoginCheckPassword; отдельные 2FA-опкоды 104/107/113 тоже есть).
  messageSend/messageNew из плана: 64/128 не проверял в этой сверке — проверить при Фазе 1
  (не критично для перепланирования).
- НОВОЕ (в плане нет): webpush-слой — WebPush-подписка (browser push протокол, endpoint+authKey+
  publicKey) регистрируется через Opcode.config по wss-сокету (web_push_service.dart:239-247);
  по логике это «пуши без FCM» уже частично реализовано в upstream. Для решения владельца п.2
  (foreground-сервис с первого дня) это меняет приоритет подзадач: webpush-механика MAX уже
  существует — изучить её пригодность вместо/вместе с FCM (отдельная мини-разведка).

### 6. Мультиаккаунт: TokenStorage, AppInstance, spoofScope, account_switcher_overlay
- Все четыре сущности живы и совпадают с описанием плана:
  - TokenStorage (lib/core/storage/token_storage.dart): auth_token_<id> в secure storage,
    active_account_id в prefs;
  - AppInstance (lib/core/storage/app_instance.dart): `String.fromEnvironment('KOMET_INSTANCE')` —
    клон приложения компайл-таймом, как в плане;
  - spoofScope: поле Api (api.dart:65), подаётся в SpoofingService.getSpoofedSessionData
    (api.dart:421-422); spoof-профиль — lib/core/storage/spoofing_service.dart + lib/models/spoof_profile.dart
    + экран lib/frontend/screens/profile/spoof_screen.dart;
  - account_switcher_overlay.dart на месте (lib/frontend/widgets/).
- Существенно для плана: SessionOptions НЕ содержит поля spoofScope — спуф применяется Дарт-слоем
  ДО сборки SessionOptions (api.dart:421+485-519:SpoofingService → deviceType/osVersion/screen/
  timezone/locale/deviceName/arch передаются полями SessionOptions). Т.е. мультиаккаунтная модель
  плана (AccountKey → свой Api с spoofScope) совместима с kolibri-стеком без правок Rust.

### 7. Цифры и дерево проекта — обновить
- Komet main: 434 dart-файла, ~139 610 строк Dart (frontend 87 916, core 22 396, backend 14 406,
  models 2 477, прочее 1 149), 64 unit-теста (все на flutter_test), version 0.5.19+19.
- Новый Rust-слой: kolibri-net ~4 228 строк Rust (+ отдельные обёртки kolibri-dart/kotlin/swift/py/go);
  в дереве Komet есть ещё native/komet_crypto (Rust, cargokit: Argon2id+ChaCha20-Poly1305+Cyrillic
  base32) и third_party/rlottie (submodule Samsung/rlottie).
- Android: Gradle 8.14 (AGP 8.11.1), Java 17, minSdk 23 (maxOf(flutter.minSdkVersion,23)),
  targetSdk = flutter-версия, flavors komet(oneme), C++-часть появилась (src/main/cpp/CMakeLists.txt).
  Upstream CI (.github/workflows): Flutter 3.44.3, JDK 17 — это contradicts мою раннюю оценку
  «Flutter 3.38»: pubspec sdk ^3.10.4 = Dart 3.10; upstream CI использует flutter 3.44.3
  (Dart 3.10.x). Для сборки брать Flutter 3.44.x.
- База: 5 (пятеро) workflow-файлов для платформ + release-dev/release-main + FCM/Play-варианты;
  у upstream уже есть CI-скелет — наш форк может наследовать, а не писать с нуля (правка задачи Т-0.1).

## Что из этого следует для перепланирования (мое, как лида)
1. Фаза 0 переформулируется: Т-0.1 (сборка) упирается в Flutter 3.44.3 + JDK 17 + cargokit (Rust
   toolchain в контейнере!) — сборка тяжелее, чем предполагал план: два нативных слоя (kolibri +
   komet_crypto) + rlottie-submodule. Это аргумент к Docker-образу сборки от ADM.
2. Frozen-пути из плана (lib/backend, lib/core/protocol, lib/core/transport) частично не существуют;
   новые frozen-зоны: kolibri (Rust-ядро, отдельный репозиторий — vendored pub-пакет!) и
   native/komet_crypto. Решение о форке: форкаем Komet, kolibri НЕ форкаем (используем pub-пакет
   ^0.1.4), наши Rust-правки (S6-гейт, SPKI-пиннинг) — проблема: их некуда класть, кроме отдельного
   форка kolibri. Это структурное решение, которое нужно положить в ADR-0000.
3. webpush-слой upstream — потенциальная замена FCM-зависимости (решение владельца п.2 п.1:
   foreground-сервис + NotificationCenter): маршрут «без FCM» уже частично есть в коде.
4. Целевая структура сравнима с планом (backend/core/frontend, models, opcodes в двух местах).

## Открытые точки, не закрытые этой сверкой (честно)
- E6-список медиа-хостов — только живым аудитом.
- vpn_bypass ↔ Rust-сокеты — гипотеза, требует живой проверки на устройстве.
- Опкоды 64/128 из плана: подтверждены после дедлайна комментария — msgSend=64, notifMessage=128
  (opcode_map.dart:86,158; kolibri MSG_SEND=64, NOTIF_MESSAGE=128). Закрыто.
- kolibri в pubspec.lock: source hosted, pub.dev, версия 0.1.4, sha256 e59a5697…b370 — НЕ
  git-override. Значит Rust-правки (S6-гейт, SPKI-пиннинг) требуют своего форка kolibri с
  dependency_override (git) — обязательный пункт ADR-0000. Закрыто.

Артефакт создан рано def160c8. Следующий шаг по решению владельца: переписать план (ADR-0000 +
перечень правок разделов) силами adm-dev-eng, потом Фаза 1 (foreground-сервис, NotificationCenter).
