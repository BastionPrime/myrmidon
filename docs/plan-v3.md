# План v3: «wellmagram» — безопасный клиент MAX с мультиаккаунтом и Telegram в одном окне, Android, дистрибуция через магазины

Версия документа: 3.0 (2026-09-19). Заменяет план v2 (2026-09-03) целиком.
Основание переписывания: сверка плана v2 с текущим кодом upstream Komet
(docs/сверка/plan-vs-code-reconciliation-20260919.md, тикет OPE-2285) — план v2 описывал Dart-транспорт,
которого в коде больше нет; решения владельца OPE-2270 (пп.2–4) и решение главы домена (п.4).
Структура разделов v2 сохранена (совместимость навигации), изменённое — помечено [v3].

Что изменилось против v2 — в двух словах:
- Транспорт — Rust-ядро kolibri (наш форк по ADR-0000), а не Dart-файлы в lib/core/transport.
- S6-гейт и SPKI-пиннинг переезжают в Rust (форк kolibri).
- Хост API — api2.oneme.ru (+ webpush wss и digital-id-слой в белом списке).
- Foreground-сервис и NotificationCenter перенесены из Фазы 4 в Фазу 1 (решение владельца п.2).
- webpush-слой upstream — кандидат на базовую доставку без FCM (раздел 4.6.3).
- Фаза 0: Т-0.1 ждёт сборочный образ ADM; разработка начинается с кода/тестов без APK.

---

## Содержание
0. Правила работы (обновл. [v3]: frozen-зоны)
1. Цель, требования, критерии успеха, не-цели
2. Анализ вариантов (без изменений против v2)
3. Проверенные факты (переписан [v3] по сверке 2026-09-19)
4. Целевая архитектура (обновл. [v3]: kolibri, webpush, digital-id)
5. Фазы и задачи (переразбита [v3])
6. Тест-план (обновл. [v3]: cargo-тесты ядра)
7. CI/CD (обновл. [v3]: cargo-гейты, образ сборки)
8. Реестр рисков (пополнен [v3])
9. Открытые вопросы для владельца
10. Definition of Done по релизам
Приложение A — Источники
Приложение B — Стартовый промпт
Приложение C — Глоссарий (пополнен [v3])

---

## 0. Правила работы для исполняющей модели

### 0.1 Общие
1. **Не переписывать базу.** База — Komet main 1ae0731 (2026-09-11): 434 dart-файла, ~139 610 строк
   Dart (frontend 87 916, core 22 396, backend 14 406, models 2 477, прочее 1 149), 64 unit-теста,
   version 0.5.19+19. Плюс Rust-слой kolibri (форк по ADR-0000, kolibri-net ~4 228 строк Rust) и
   native/komet_crypto (Argon2id+ChaCha20-Poly1305+Cyrillic base32, cargokit), third_party/rlottie
   (submodule Samsung/rlottie). Всё новое добавляется модулями и адаптерами.
   [v3] «Замороженные» пути (правки только по явному разрешению владельца, минимальные):
   - в дереве Komet: `lib/backend/**`, `lib/core/protocol/**`, `lib/core/transport/**` (то, что от
     него осталось: dispatcher, tls_config, traffic_monitor, vpn_bypass), а также
     `native/komet_crypto/**`, `third_party/rlottie`;
   - в форке kolibri: правки только через задачи S6/SPKI/bind-interface (ADR-0000), тонким слоем
     поверх upstream; каждая правка ядра — отдельная ветка/PR с cargo-тестом.
2. **Одна задача — одна ветка — один PR.** Размер PR: до ~800 изменённых строк, кроме
   сгенерированного кода (frb_generated.dart не считаем). В описании PR: цель, изменённые файлы,
   как проверено, что осталось.
3. **Проверки перед PR [v3]:** `flutter analyze` без ошибок; `flutter test` зелёный; при
   затронутом Rust-ядре — `cargo test`/`cargo clippy` в форке kolibri; сборка APK — только при
   доступном сборочном образе (см. Т-0.1 v3); smoke-сценарий задачи на устройстве/эмуляторе при
   наличии окружения.
4. **Эксперименты раньше архитектуры.** Решения по пушам (4.6) — только после E1–E6 (Фаза 0).
5. **Когда неясно — остановиться.** Не угадывать бизнес-решения, юридические вопросы, имена, ключи.
6. **Отчёт после каждой задачи** в формате B.3.

### 0.2 Лицензии и бренды
- Komet — GPL-3.0 → форк остаётся GPL-3.0, исходники публикуются. [v3] kolibri — MIT OR
  Apache-2.0 (LICENSE-APACHE/LICENSE-MIT в репозитории kolibri) — форк kolibri также MIT/Apache,
  совместимо. TDLib — Boost Software License 1.0. Все новые зависимости — проверить лицензию,
  записать в `THIRD_PARTY.md`.
- В названии, иконке, скриншотах и промо не использовать «MAX», «МАХ», «Telegram», их логотипы и
  фирменные цвета. Допустимо номинативное упоминание в описании: «альтернативный клиент,
  совместимый с MAX; использует Telegram API».
- Имя приложения, package name, ключ подписи — плейсхолдеры до решения владельца.

### 0.3 Инварианты безопасности (нарушение = блокер)
S1 Нет соединений ни с чем, кроме серверов MAX, серверов Telegram (DC MTProto) и — только в flavor
   `google` — FCM. [v3] Белый список MAX (по сверке, финально — по E6-аудиту): `api2.oneme.ru`
   (API), `api.oneme.ru` + `web.max.ru` (webpush, wss://api.oneme.ru/websocket), `su.oneme.ru`
   (media upload), `digital-id.max.ru` и `ext-api.max.ru` (модуль digital_id — новый в v3),
   `legal.max.ru`/`www.max.ru`/`max.ru` (l10n-тексты и статические ссылки, не сетевые клиенты).
   Медиа-хосты — подтверждает E6. Никаких собственных бэкендов, аналитики, crash-репортинга.
S2 Секреты (токены MAX, TDLib database encryption key, api_hash) — только в
   `flutter_secure_storage`. Никаких секретов в SharedPreferences, логах, файлах без шифрования.
S3 Спуф-профиль устройства уникален на каждый аккаунт MAX; создаётся при добавлении аккаунта;
   не меняется без действия пользователя. [v3] Реализация SpoofingService/spoofScope
   подтверждена сверкой; спуф применяется Dart-слоем ДО сборки SessionOptions (в kolibri поля
   SessionOptions deviceType/osVersion/screen/timezone/locale/deviceName/arch) — модель
   мультиаккаунта v2 совместима без правок Rust.
S4 В `pubspec.yaml` и Gradle нет `firebase_analytics`, `firebase_crashlytics`, `sentry`,
   `appmetrica`, рекламных SDK. В flavor `foss` нет Firebase вообще.
S5 Опасные разрешения только по фиче и только runtime; в сборках `foss`/store лишние
   `uses-permission` удаляются.
S6 [v3] Dev-переключатель `dev_tls_insecure` недоступен в release с компиляционной гарантией —
   гейт реализуется в Rust-ядре (форк kolibri, ADR-0000): в release-конфигурации
   `SessionOptions.insecureTls=true` отклоняется ядром; Dart-часть задачи снимается (детали —
   Т-5.2 v3, Фаза 5).
S7 Экран «Что видит сервер» и дисклеймер первого запуска обязательны (см. 4.7).

---

## 1. Цель, требования, критерии успеха, не-цели

Без изменений против v2 (требования R1–R5, критерии C1–C6, не-цели — v2 раздел 1).
[v3] Уточнение C4: сетевой аудит релизной сборки (30 минут активности) — хосты только из белого
списка `SECURITY.md` (состав по S1 v3, включая webpush и digital-id).

---

## 2. Анализ вариантов «сверху»

Без изменений против v2 (разделы 2.1–2.3). Выбран вариант A: форк Komet + TDLib.
[v3] Дополнительный факт к 2.3: сборка Komet тяжелее, чем предполагал v2 — два cargokit-слоя
(kolibri + komet_crypto), Rust toolchain, rlottie-submodule, JDK 17, Flutter 3.44.3 (Dart 3.10.x,
pubspec sdk ^3.10.4; upstream CI: flutter 3.44.3 + JDK 17). Это учтено в Т-0.1 v3 (сборочный
образ как внешняя зависимость), но не меняет выбор варианта.

---

## 3. Проверенные факты [v3 — переписан по сверке 2026-09-19]

### 3.1 Код Komet (main 1ae0731, 2026-09-11) — структура и транспорт
Структура:
```
lib/backend/api.dart                         Api: сессия, spoofScope → SessionOptions
lib/backend/modules/account.dart             AccountModule (login, push, privacy)
lib/backend/modules/account/privacy_module.dart   registerPushToken → Opcode.config
lib/backend/modules/messages.dart            MessagesModule
lib/core/protocol/opcode_map.dart            опкоды (сгенерирован из kolibri opcodes.rs, ручная синхронизация двух мест)
lib/core/transport/dispatcher.dart           диспетчер запросов над kolibri-сессией
lib/core/transport/tls_config.dart           тонкая обёртка: applyMincifryTrust / isInsecureAllowed (prefs dev_tls_insecure)
lib/core/transport/traffic_monitor.dart
lib/core/transport/vpn_bypass.dart           148 строк; работа против Rust-сокетов — под вопросом (см. п.4)
lib/core/webpush/{max_web_protocol,max_web_socket,web_push_service}.dart   webpush-слой [новое в v3]
lib/core/push/push_service.dart              FCM, локальные уведомления, quick reply
lib/core/storage/token_storage.dart          auth_token_<id> (secure storage), active_account_id (prefs)
lib/core/storage/app_instance.dart           compile-time KOMET_INSTANCE
lib/core/config/config.dart                  defaultHost = api2.oneme.ru:443 (+override через prefs server_host_override)
lib/core/calls/                              WebRTC, ws2_signaling
lib/frontend/widgets/account_switcher_overlay.dart
android/app/build.gradle.kts                 flavors komet/oneme, Gradle 8.14 (AGP 8.11.1), Java 17, minSdk 23, C++-часть
native/komet_crypto                          Rust, cargokit: Argon2id+ChaCha20-Poly1305+Cyrillic base32 [новое в v3]
third_party/rlottie                          submodule Samsung/rlottie [новое в v3]
```
Транспорт [v3]: Dart-транспорт удалён upstream. Ядро — Rust: kolibri-net/src/transport/
{client,tls,proxy,dispatcher,error,wiretap}.rs; rustls (ClientConfig, tokio_rustls), не
SecureSocket/onBadCertificate. Пакет `kolibri: ^0.1.4` (pub.dev, hosted, sha256 e59a5697…b370);
в wellmagram — свой форк по ADR-0000 (dependency_overrides git). Проксирование — в Rust
(transport/proxy.rs: http/socks5/socks5h с auth, `scheme://[user:pass@]host:port`), настройка из
Dart — поле `SessionOptions.proxy` (api.dart: _buildProxyUrl → openSessionWithWireLog).
Dart-side ProxyConnector не нужен. Dev-insecure TLS: TlsConfig.isInsecureAllowed() (Dart) →
SessionOptions.insecureTls (api.dart:495,518) → Rust build_client_config(insecure:true) →
AcceptAnyCert (tls.rs:57-67) — компиляционной гарантии нет (см. S6/Т-5.2).
Встроенный минцифры-траст: MINCIFRY_CA_PEM (include_str, tls.rs), TRUST_MINCIFRY AtomicBool,
setTrustMincifryCa из Dart — зона для сосуществования с SPKI-пиннингом.
VPN bypass: vpn_bypass.dart остаётся в Dart — эффективность против Rust-сокетов под вопросом
(сокеты открывает Rust; bind-to-interface из Dart может не работать); задача Т-0.x v3.

Пуши [v3]: PushService.init → Firebase.initializeApp → FirebaseMessaging.getToken →
AccountModule.registerPushToken → PrivacyModule.registerPushToken (opcode config=22, payload
`{'pushToken': token, 'pushOptions': 0}`; unregisterPushToken тоже есть). Опкоды: в двух местах,
синхронизированы руками (kolibri opcodes.rs сгенерирован из lib/core/protocol/opcode_map.dart).
Таблица опкодов v3: ping=1, sessionInit=6, authRequest=17, auth=18 (проверка кода), login=19,
sync=21 (v2 ошибочно писал «19 sync»), config=22, authLoginCheckPassword=115 (облачный пароль;
отдельные 2FA-опкоды 104/107/113), history=49, messageSend=64 (msgSend), incoming=128
(notifMessage). msgSend=64 и notifMessage=128 подтверждены (opcode_map.dart:86,158; kolibri
MSG_SEND=64, NOTIF_MESSAGE=128).

Мультиаккаунт [v3]: TokenStorage (auth_token_<id> secure storage, active_account_id prefs),
AppInstance (String.fromEnvironment KOMET_INSTANCE, compile-time клон), spoofScope (поле Api,
api.dart:65 → SpoofingService.getSpoofedSessionData, api.dart:421-422; профиль —
lib/core/storage/spoofing_service.dart + lib/models/spoof_profile.dart + экран
lib/frontend/screens/profile/spoof_screen.dart), account_switcher_overlay.dart — все четыре
сущности живы, совпадают с v2. SessionOptions НЕ содержит spoofScope — спуф применяется Dart-слоем
до сборки SessionOptions (api.dart:421+485-519: deviceType/osVersion/screen/timezone/locale/
deviceName/arch передаются полями SessionOptions). Модель мультиаккаунта v2 (AccountKey → свой Api
с spoofScope) совместима с kolibri-стеком без правок Rust.

Разрешения (manifest): INTERNET, CAMERA, RECORD_AUDIO, ACCESS_FINE/COARSE_LOCATION, BLUETOOTH_*,
NFC, REQUEST_INSTALL_PACKAGES, POST_NOTIFICATIONS, FOREGROUND_SERVICE(+DATA_SYNC, +MICROPHONE),
USE_FULL_SCREEN_INTENT, READ_MEDIA_* (без изменений против v2).

Зависимости [v3]: flutter_secure_storage, sqflite, firebase_core/messaging,
flutter_local_notifications, flutter_webrtc, opus, media_kit, flutter_inappwebview, geolocator,
sensors_plus, mobile_scanner, app_links — подтверждены; ИЗ v2 сняты msgpack_dart, dart_lz4,
ffi-транспортные зависимости (уехали в Rust-ядро kolibri); ДОБАВЛЕНЫ: kolibri ^0.1.4 (→ наш форк),
komet_crypto (path: native/komet_crypto), web-push библиотеки webpush-слоя.

Цифры [v3]: 434 dart-файла; ~139 610 строк Dart (frontend 87 916, core 22 396, backend 14 406,
models 2 477, прочее 1 149); 64 unit-теста (flutter_test); version 0.5.19+19; Rust: kolibri-net
~4 228 строк + обёртки kolibri-dart/kotlin/swift/py/go; Gradle 8.14 (AGP 8.11.1), Java 17, minSdk
23, targetSdk = flutter-версия; Flutter 3.44.3 (Dart 3.10.x, pubspec sdk ^3.10.4); CI upstream:
5 workflow-файлов для платформ + release-dev/release-main + FCM/Play-варианты — форк наследует
CI-скелет, а не пишет с нуля.

### 3.2 Протокол MAX [v3]
«Сырое» TLS-соединение с `api2.oneme.ru:443`; кадр = 10-байтный заголовок
`[ver:u8][cmd:u16][seq:u8][opcode:u16][packedLen:u32]` (старший байт packedLen — флаг LZ4),
нагрузка MessagePack; пинг (opcode 1) каждые 30 с — формат кадра и опкоды в целом совпадают с v2
(kolibri opcodes.rs явно сгенерирован из opcode_map.dart). [v3-новое] webpush-слой: wss-соединение
wss://api.oneme.ru/websocket (max_web_socket.dart:55), web-push подписки регистрируются через
Opcode.config по wss-сокету (web_push_service.dart:239-247); digital-id: ext-api.max.ru,
digital-id.max.ru (модуль digital_id). Вход по телефону/SMS — только в мобильном протоколе.

### 3.3–3.8 (Avenarius, Telegram, Google Play, RuStore, верификация, аналоги)
Без изменений против v2.

---

## 4. Целевая архитектура

### 4.1 Слои [v3-дельта]
```
┌──────── UI (Flutter, lib/frontend) ────────┐
│ ChatListScreen (unified) │ ChatScreen (unified) │ AccountSwitcher │ Settings │ Onboarding │
└──────────────────────────┬─────────────────┘
                           │ UnifiedChat / UnifiedMessage / AccountKey
┌──────────────────────────┴─────────────────┐
│ Application layer (lib/core/app)           │
│  AccountRegistry · SessionManager(switch|parallel) · ChatListAggregator · NotificationCenter [v3: с Фазы 1] │
│  CredentialStore · SpoofProfileStore · ProxySettings · FeatureFlags · Capabilities │
└──────────────┬─────────────────────────────┘
               │ MessengerBackend
┌──────────────┴───────────────┐  ┌──────────┴────────────────┐
│ MaxBackend (adapter)         │  │ TelegramBackend           │
│  wraps existing Api (→       │  │  TdBridge (FFI tdlib_ex | │
│  SessionOptions/kolibri),    │  │  Kotlin JNI)              │
│  AccountModule, Messages…    │  │  per-account TDLib client │
│  per-account AppDatabase     │  │  per-account db/files dir │
└──────────────┬───────────────┘  └──────────────┬────────────┘
               │ TCP+TLS api2.oneme.ru:443 (Rust, kolibri-форк)  │ MTProto → Telegram DC
               │ + webpush wss (кандидат доставки, 4.6.3)
┌──────────────┴────────────────────────────────┴──────────────┐
│ Platform (Kotlin): ConnectionForegroundService [v3: с Фазы 1] · FcmEntry (google flavor) · BootReceiver │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Модель аккаунтов и сессий
Без изменений против v2 (AccountKey/Network/AccountProfile/SessionMode/SessionManager; правила
switch/parallel; миграция auth_token_<id> → cred:max:<id>). [v3] Совместимость с kolibri
подтверждена сверкой: per-account Api со своим spoofScope не требует правок Rust (см. S3).
[v3] Уточнение: поля SessionOptions для MAX-сессии заполняются из спуф-профиля (deviceType,
osVersion, screen, timezone, locale, deviceName, arch); host/port — из config.dart (api2) или
server_host_override; proxy — из ProxySettings (URL-формат 3.1).

### 4.3 Интерфейс бэкенда
Без изменений против v2 (MessengerBackend: capabilities/state/events/chats/history/sendText/
sendMedia/editText/deleteMessages/setReaction/markRead/setTyping/downloadMedia/registerPush/
unregisterPush/setGhostMode).

### 4.4 Telegram backend
Без изменений против v2 (два варианта моста, сборка TDLib в CI, авторизация, апдейты, ghost mode,
мультиаккаунт). [v3] Сборка TDLib-артефактов идёт в том же сборочном образе, что и Rust-слои
(образ ADM: Rust toolchain + NDK + CMake + JDK 17).

### 4.5 Единые модели и маппинг
Без изменений против v2.

### 4.6 Уведомления и фон [v3 — перепланировано]
Два flavor по измерению `push`:
- **`foss` (базовый).** Без Firebase. [v3] `ConnectionForegroundService` (Kotlin) переносится в
  Фазу 1 (решение владельца п.2) и является базой доставки с первого дня: тип FGS
  `remoteMessaging` (targetSdk ≥ 34; fallback `dataSync`), background Flutter engine
  (FlutterEngineCache), держит сессии (MAX активную или все в parallel; все TDLib-клиенты),
  уведомление «<APP_NAME>: N аккаунтов подключено» + действие «Пауза», автозапуск по
  BOOT_COMPLETED, реконнект с экспоненциальной задержкой, учёт смены сети, запрос
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS с объяснением.
- **`google` (опция).** FCM — по E1/E2/E3 (Фаза 0) и ⛔ В1 (раздел 9).
- **`webpush` (кандидат, 4.6.3).** [v3-новое] webpush-слой upstream: MAX уже имеет механизм
  «пуши без FCM» — WebPush-подписка (browser push протокол: endpoint+authKey+publicKey)
  регистрируется через Opcode.config по wss-сокету (web_push_service.dart:239-247; wss-соединение
  wss://api.oneme.ru/websocket). Мини-разведка в Фазе 0 (E7): пригодность webpush как
  (а) базовой доставки foss-сборки без FCM и foreground-пуши wss; (б) дополнения к FCM в google;
  (в) требования к фону (жизнеспособность wss-сокета под Doze, рестарт вебпуша из FGS).
  Решение — в ADR-0002 (push-стратегия) по итогам E1/E2/E4/E7.

Независимо от flavor: `NotificationCenter` (Dart) — единая точка формирования уведомлений:
каналы (сообщения, звонки MAX, служебный), группировка по чату, quick reply (обе сети), decline
звонка (MAX), бейджи. [v3] Переносится в Фазу 1 (решение владельца п.2): с Фазы 1 любое
BackendEvent → уведомление через NotificationCenter (источник — FGS+живое соединение, FCM или
webpush — по мере подключения), фазы 3–4 только достраивают интеграции (группировка, quick reply,
бейджи — Т-3.6 остаётся в Фазе 3 как дообучение интерфейса).

### 4.7 Безопасность: модель угроз и меры [v3-дельта]
Противники: (1) сервер MAX/VK — метаданные, fingerprint, детект клиента, бан; (2) Google —
телеметрия GMS/FCM; (3) локальный доступ к устройству — токены, БД; (4) сетевой MITM; (5) другие
приложения; (6) авторы форка — снимается открытым кодом и воспроизводимой сборкой.

Меры (нумерация v2 сохранена):
1. S1–S7 (0.3); S1-белый список — по v3-составу (webpush/digital-id-хосты).
2. [v3] Удаление пути dev_tls_insecure в release: гейт в Rust-ядре (форк kolibri,
   ADR-0000) — compile-time гарантия; Dart-сторона (tls_config.dart) остаётся debug-обёрткой,
   тестируемой на непоявление в release-путях. Тест: cargo-тест в форке (в release-конфигурации
   insecureTls=true отклоняется) + flutter-тест, что release-сборка не подхватывает переключатель.
3. [v3] SPKI-пиннинг для `api2.oneme.ru`: кастомный ServerCertVerifier в kolibri-net
   (transport/tls.rs), набор SPKI-пинов, «мягкий» режим (при несовпадении — предупреждение и
   запрет входа, не тихий байпас), сосуществование с минцифры-трастом (MINCIFRY_CA_PEM/
   TRUST_MINCIFRY). Обновление пинов — через релиз (перегенерация списка пинов).
4. allowBackup=false, dataExtractionRules без секретов; опциональный FLAG_SECURE; app-lock
   (PIN/биометрия) через local_auth.
5. Spoof-профиль на аккаунт (S3); экран просмотра/регенерации.
6. Антибан-правила (4.8) закодированы в MaxBackend (rate limiter).
7. VPN bypass — выключен по умолчанию, отдельный экран с объяснением «MAX увидит ваш реальный
   IP». [v3] Техническая проверка эффективности против Rust-сокетов — отдельная задача
   (Т-1.9 v3, решение в ADR-0004).
8. Удаление аккаунта: токен, БД, кэш медиа, спуф-профиль, TDLib-директория, push-регистрация —
   всё стирается; тест на отсутствие остатков.
9. Экспортируемые компоненты: только необходимые; exported=false по умолчанию.
10. Экран S6 «Что видит сервер» (MAX — номер, IP, содержимое, метаданные, fingerprint-спуф;
    Telegram — номер, IP, «неофициальный клиент → под наблюдением»; [v3] digital-id-слой —
    упомянуть передачу данных digital-id при его использовании). Экран S7 — дисклеймер первого
    запуска.
11. Логи: без токенов/номеров/содержимого; в release уровень warning.

### 4.8 Антибан-правила (MAX)
Без изменений против v2.

### 4.9 Сборочные измерения
Без изменений против v2 (push: foss/google; distribution: github/fdroid/play/galaxy; dart-define
ENABLE_MAX/ENABLE_TELEGRAM/TG_API_ID/TG_API_HASH/FEATURE_NFC_BLE/FEATURE_GEO/
FEATURE_SELF_UPDATE). [v3] Дополнительно: dart-define BUILD_IMAGE_PIN (пин версии сборочного
образа, для воспроизводимости) — опционально.

---

## 5. Фазы и задачи [v3 — переразбита]

Формат задачи: **Цель · Входы · Шаги · Файлы · Приёмка · Оценка**. Оценки — календарные дни при
работе модели с ревью владельца раз в день. «Ждёт окружение» = задача блокирована внешней
зависимостью (сборочный образ ADM), выполняется параллельная часть без APK.

### Фаза 0 — Bootstrap и эксперименты (10–14 дней)

**Т-0.1 Форк, сборка, документация окружения [v3: ждёт окружение; начинать с кода/тестов без APK]
(1–2 д после образа + параллельно без образа)**
- Цель: воспроизводимая сборка wellmagram (форка Komet).
- [v3] Внешняя зависимость: сборочный образ ADM — Rust toolchain + NDK + CMake + JDK 17 + Flutter
  3.44.3, два cargokit-слоя (kolibri-форк + native/komet_crypto), third_party/rlottie submodule.
  Образ готовит инфраструктура (adm); до его готовности Т-0.1 помечен «ждёт окружение».
- [v3] Начать без образа (решение главы домена п.4): клон форка Komet + подключение форка kolibri
  (dependency_overrides git по ADR-0000), `flutter pub get` (без native-сборки), `flutter
  analyze`, `flutter test` (64 unit-теста upstream), фиксация версий (Flutter 3.44.3/Dart
  3.10.x/Gradle 8.14/AGP 8.11.1/JDK 17/minSdk 23) в docs/BUILD.md; CI-скелет наследуется от
  upstream (.github/workflows — 5 workflow-файлов + release-dev/release-main, правки под наш
  форк/репозиторий). Сборку APK не запускать до образа.
- Приёмка: pub get/analyze/test зелёные в контейнере без нативной сборки; BUILD.md зафиксировал
  версии и требование образа; CI-скелет адаптирован. [После образа] `flutter build apk --flavor
  komet --debug` собирается; APK логинится тестовым аккаунтом; CI зелёный.
- Оценка: 1–2 д (код/CI) + 1 д (сборка после готовности образа).

**Т-0.2 Минимальный ребрендинг и очистка flavors (1 д)**
Без изменений против v2 (applicationId, namespace, имя, временная иконка; flavor `oneme` удалить
из main-ветки в experiments/oneme; KOMET_INSTANCE-логику не использовать).

**Т-0.3 Сборка TDLib в CI (2–3 д)**
- [v3] Сборка TDLib идёт в том же сборочном образе ADM (Rust+NDK+CMake+JDK 17), артефакты
  .so для 3 ABI, кэш по хэшу коммита TDLib, smoke-тест. Остальное без изменений против v2.
- [v3] До готовности образа: готовить workflow и скрипты (без запуска сборки).

**Т-0.4 E1 — MAX-пуш под собственным package (1 д + 24 ч наблюдения)**
Без изменений против v2 (google-services.json проекта max-messenger-app с нашим package_name;
проверка токена, Opcode.config без WRONG_DEVICE_TOKEN, доставка при убитом процессе, стабильность
24 ч; docs/experiments/E1.md; ⛔ STOP).

**Т-0.5 E2 — Telegram-пуш (1 д + 24 ч)**
Без изменений против v2 (собственный Firebase-проект или конфигурация официального Telegram;
⛔ STOP).

**Т-0.6 E3 — выбор моста TDLib (2 д)**
Без изменений против v2 (оба варианта 4.4, метрики, ADR-0001).

**Т-0.7 E4 — два sender ID (0.5 д)**
Без изменений против v2.

**Т-0.8 E5 — параллельные сессии MAX (1 д + 48 ч)**
- [v3] Сессии создаются через per-account Api со своим spoofScope (совместимость с kolibri
  подтверждена); два тестовых аккаунта, 48 ч онлайн, фиксация разрывов/реакций сервера/батареи.
  ⛔ STOP: решение о parallel в 1.0. Остальное без изменений.

**Т-0.9 E6 — сетевой аудит Komet «как есть» (0.5 д)**
- [v3] Ожидаемый список хостов по сверке: api2.oneme.ru, api.oneme.ru (webpush wss), web.max.ru,
  su.oneme.ru (media upload), digital-id.max.ru, ext-api.max.ru, legal/www/max.ru (статические),
  при flavor oneme — FCM/GMS; медиа-хосты — по живому аудиту (фиксированного списка нет, URL
  приходит от сервера). Результат → SECURITY.md v0. Остальное без изменений.

**Т-0.10 [v3-новое] E7 — мини-разведка webpush-слоя (1–2 д)**
- Цель: оценить webpush-слой upstream (lib/core/webpush/: max_web_protocol, max_web_socket,
  web_push_service) как кандидата на базовую доставку без FCM (см. 4.6.3).
- Шаги: чтение кода слоя; проверка жизнеспособности wss-сокета в фоне (в связке с
  ConnectionForegroundService из Фазы 1); сравнение с E1-результатами; метрики латентности
  доставки vs FCM vs живое соединение.
- Результат: docs/experiments/E7.md; вход в ADR-0002 (push-стратегия: webpush vs FCM vs
  foreground-only).

Выход Фазы 0: ADR-0001 (мост TDLib), ADR-0002 (push-стратегия по E1/E2/E4/E7), ADR-0003 (режим
parallel), SECURITY.md v0 (список хостов по E6 — v3-состав).

### Фаза 1 — Модель аккаунтов, адаптеры и фон [v3: + foreground-сервис и NotificationCenter, − Т-4.1/Т-4.2 частично]
(14–20 дней [v3], бывшие 14–20 д + переносForeground из Фазы 4)

**Т-1.1 Каркас lib/core/accounts/ (2 д)** — AccountKey, Network, AccountProfile, AccountRegistry
(persist в prefs как JSON без секретов), события. Unit-тесты.

**Т-1.2 CredentialStore (1 д)** — обёртка над flutter_secure_storage; миграция auth_token_<id> →
cred:max:<id>; тест миграции; удаление.

**Т-1.3 Интерфейс MessengerBackend, модели unified (2 д)** — lib/core/backends/
messenger_backend.dart, lib/core/models/unified/*.dart; Capabilities; BackendEvent.

**Т-1.4 MaxBackend (4–5 д)** — обёртка над Api/AccountModule/MessagesModule; [v3] сессии через
kolibri (SessionOptions из спуф-профиля, host из config/override, proxy-URL из ProxySettings —
формат 3.1 v3); мапперы MAX→Unified с тестами; registerPush делегирует в PrivacyModule
(opcode config=22); ghost-режимы MAX через существующую «невидимку».

**Т-1.5 Per-account AppDatabase (3 д)** — AppDatabase.forAccount(AccountKey); миграция единой БД;
кэш медиа per-account; тест удаления аккаунта.

**Т-1.6 SpoofProfileStore (1 д)** — профиль на AccountKey; генерация правдоподобных пар
(таблица model/os_version); экран просмотра/регенерации.

**Т-1.7 SessionManager (3 д)** — режимы switch/parallel для MAX; активный аккаунт; интеграция с
account_switcher_overlay.dart без изменения внешнего поведения.

**Т-1.8 Антибан rate-limiter (1 д)** — MaxBackend.lookupPhone через очередь 4.8; UI-индикация.

**Т-1.9 [v3-новое] ConnectionForegroundService (4–5 д; из Т-4.1 v2)**
- Kotlin; тип FGS remoteMessaging (fallback dataSync); background Flutter engine
  (FlutterEngineCache); держит сессии MAX (активную или parallel) + TDLib-клиенты; уведомление
  «<APP_NAME>: N аккаунтов подключено» + «Пауза»; BOOT_COMPLETED; реконнект с экспоненциальной
  задержкой, учёт смены сети; запрос REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.
- Приёмка: сервис стартует с приложением, держит соединение ≥ 1 ч, переживает Doze-период (по
  возможностям окружения), уведомление и «Пауза» работают.

**Т-1.10 [v3-новое] NotificationCenter (3 д; из Т-3.6 v2) — каркас**
- Dart; единая точка формирования уведомлений: каналы (сообщения, звонки MAX, служебный),
  группировка по чату, бейджи; BackendEvent → уведомление (источник — живое соединение через FGS
  из Т-1.9).
- [v3] Т-3.6 (Фаза 3) остаётся как дообучение: quick reply, decline звонка, финальная
  группировка/тесты на формирование из BackendEvent всех бэкендов.
- Приёмка: NewMessage-событие из живого соединения → локальное уведомление на устройстве
  (debug-сборка, где доступно).

**Т-1.11 [v3-новое] Проверка vpn_bypass против Rust-сокетов (1 д + живой тест)**
- Цель: гипотеза сверки — vpn_bypass.dart (bind-to-interface из Dart) может не работать против
  сокетов, открываемых Rust-ядром.
- Шаги: код-ревью механизма bind в vpn_bypass.dart против клиентского сокета в
  kolibri-net/transport/client.rs; [open] при подтверждении гипотезы — задача в форк kolibri
  (bind_interface в SessionOptions) отдельным тикетом (ADR-0000 п.3); решение в ADR-0004.
- Приёмка: вывод зафиксирован (работает/не работает/нужна правка ядра) в docs/experiments/.

- Приёмка фазы: все функции Komet работают как раньше (регресс-чеклист 6.2); flutter test ≥ 80 %
  покрытия новых модулей; переключение аккаунтов MAX ≤ 1 с; FGS держит соединение; NotificationCenter
  показывает локальные уведомления.

### Фаза 2 — Telegram backend (25–35 дней)
Без изменений против v2 (Т-2.1–Т-2.10) с [v3] уточнениями: Т-2.10 push — по ADR-0002 (включая
webpush-опцию E7); сборка артефактов TDLib — в образе ADM.

### Фаза 3 — Единый UI (18–25 дней)
Т-3.1–Т-3.5, Т-3.7 без изменений против v2.
**Т-3.6 NotificationCenter — дообучение [v3]:** quick reply (обе сети), decline звонка (MAX),
группировка по чату, тесты на формирование уведомлений из BackendEvent всех бэкендов (каркас —
Т-1.10 v3).
- Приёмка: C1 из 1.2 в debug; UI-тесты ключевых экранов (integration_test).

### Фаза 4 — Фон и пуши: дообучение [v3 — сокращена]
(6–10 дней [v3], было 12–18)

**Т-4.1 [v3] Политика удержания (2 д)** — какие сессии держать в каком режиме; экономный режим
(только активный MAX + TG-клиенты в «offline sync» по таймеру). База (сервис) — уже Т-1.9.

**Т-4.2 [v3] Батарея и OEM (3 д)** — измерения на Pixel/Samsung/Xiaomi (Battery Historian, 24 ч);
docs/OEM_BATTERY.md; запрос исключения из оптимизации. [v3] Если E7 положителен — измерения
включают webpush-режим доставки.

**Т-4.3 [v3] google flavor (3–4 д, если ADR-0002 разрешает)** — FcmEntry (Kotlin) → маршрутизация
payload в нужный бэкенд; вторая сеть остаётся на сервисе. [v3] При webpush-решении ADR-0002 —
интеграция webpush-канала в политику доставки (wss-поддержка из FGS).

**Т-4.4 [v3] Пауза/возобновление (1 д)** — из уведомления и настроек; корректное закрытие сокетов
(MAX-сессии kolibri + wss webpush + TDLib).

- Приёмка: C2, C5 из 1.2. [v3] C2 уточнён: в foss — ≤ 10 с (foreground-сервис, webpush или живое
  соединение), в google — ≤ 5 с где FCM работает по E1/E2/E7.

### Фаза 5 — Безопасность и приватность (8–12 дней)

**Т-5.1 Разрешения и фиче-флаги (2 д)** — без изменений против v2.
**Т-5.2 [v3] S6: компиляционный гейт dev_tls_insecure — переезд в Rust (1–2 д)**
- [v3] Вместо Dart-гейта: compile-time гейт в форке kolibri (ADR-0000): cargo-feature/const в
  kolibri-net — в release-конфигурации SessionOptions.insecureTls=true отклоняется (ошибка
  сессии), в debug — работает. Тест: cargo-тест в форке (unit: release-конфигурация отклоняет;
  debug — принимает) + flutter-тест на непроникновение переключателя в release-пути. Dart-часть
  v2-задачи снимается (tls_config.dart остаётся debug-обёрткой).
- Оценка: 1–2 д (Rust + тесты + ревью adm-dev-review + bump форка в pubspec через PR).
**Т-5.3 [v3] SPKI-пиннинг в Rust (2–3 д)**
- [v3] Вместо Dart/SecureSocket: кастомный ServerCertVerifier в kolibri-net/src/transport/tls.rs
  (рядом AcceptAnyCert и root_store()); набор SPKI-пинов; «мягкий» режим (несовпадение →
  предупреждение и запрет входа); сосуществование с минцифры-трастом (MINCIFRY_CA_PEM/
  TRUST_MINCIFRY). Процедура обновления пинов — через релиз. Dart-часть v2-задачи снимается.
  Тест: cargo-тест на верификатор (совпадение/несовпадение пина/мягкий режим) + интеграционная
  проверка против тестового хоста с пином.
**Т-5.4 allowBackup=false, dataExtractionRules, app-lock, FLAG_SECURE (2 д)** — без изменений.
**Т-5.5 Экраны S6/S7 (1–2 д)** — [v3] + digital-id-блок в «Что видит сервер».
**Т-5.6 Сетевой аудит релизной сборки (1 д)** — SECURITY.md финальный (v3-список хостов);
  tools/net_audit.sh.
**Т-5.7 Подпись и целостность (1 д)** — без изменений.

- Приёмка: C4; чеклист 0.3 подписан владельцем; [v3] cargo-тесты форка kolibri зелёные в CI.

### Фаза 6 — Дистрибуция (10–14 дней + модерации)
Т-6.1–Т-6.10 без изменений против v2, с [v3] уточнением Т-6.2: две схемы pubspec — google/foss;
[v3] dependency_overrides kolibri-git общий для обеих (форк по ADR-0000), webpush-зависимости
только там, где ADR-0002 их сохраняет.

### Фаза 7 (после 1.0, опционально) — раздельная архитектура (вариант C)
Без изменений против v2.

---

## 6. Тест-план [v3-дельта]

### 6.1 Уровни
- Unit (Dart): мапперы, AccountRegistry, CredentialStore, rate-limiter, ChatListAggregator,
  NotificationCenter. Цель ≥ 80 % по новым модулям.
- [v3] Unit (Rust, форк kolibri): S6-гейт (release-отклонение), SPKI-верификатор (пин совпал/
  не совпал/мягкий режим), опции сессии; запускаются в CI форка (cargo test/clippy).
- Интеграционные (gated TEST_ACCOUNTS=1): вход MAX (тестовый номер), вход TG, отправка/приём
  между двумя тестовыми аккаунтами, восстановление сессий после перезапуска, удаление аккаунта
  без остатков, [v3] живое wss/webpush-соединение из FGS.
- UI (integration_test): список чатов, экран чата, переключатель, настройки.
- Ручные: чеклист 6.2 перед каждым релизом.

### 6.2 Регресс-чеклист Komet (не должен деградировать)
Вход QR/SMS/2FA MAX; список чатов; отправка текста/фото/видео/файла/голосового/кружка; реакции;
ответы; редактирование/удаление; стикеры; звонки 1:1 и групповые (MAX); профиль/инфо чата;
невидимка; спуф; прокси ([v3] через SessionOptions.proxy); уведомления и quick reply;
переключение аккаунтов. [v3] webpush-механика upstream — если она на момент регресса включена
в наших сборках.

### 6.3 Матрица устройств
Без изменений против v2 (Pixel, Samsung One UI, Xiaomi HyperOS, без GMS — GrapheneOS/эмулятор;
эмуляторы x86_64 для CI).

### 6.4 Специальные проверки
- Батарея: Battery Historian, 24 ч, три конфигурации сессий. [v3] + webpush-режим.
- Сеть: PCAPdroid, белый список хостов (v3-состав: api2.oneme.ru, webpush, digital-id, медиа по
  E6); проверка отсутствия DNS-запросов к неизвестным доменам.
- Безопасность хранилища: adb backup невозможен; в shared_prefs нет токенов.
- Антибан: тест rate-limiter; «20 lookup подряд» → очередь.
- [v3] Rust: cargo test + clippy в CI форка kolibri (как gate ревью правок ядра).

---

## 7. CI/CD (GitHub Actions) [v3-дельта]
| Workflow | Триггер | Что делает |
|---|---|---|
| [v3] `kolibri.yml` (в форке kolibri) | push/PR | `cargo test`, `cargo clippy`, `cargo fmt --check` в kolibri-net; барьер мерджа для правок ядра |
| `build-tdlib.yml` | ручной / смена TDLIB_COMMIT | сборка .so для 3 ABI (образ ADM), кэш, артефакты |
| `build-android.yml` | push/PR | flutter analyze, flutter test, debug-APK по матрице flavors (образ ADM), интеграционные тесты на эмуляторе |
| `release.yml` | тег v* | release-APK по ABI и flavors, подпись из секретов, apksigner verify, SHA-256, changelog, GitHub Releases + собственный F-Droid-репозиторий |
| `net-audit.yml` | ручной | сборка release + инструкция; результат вручную в SECURITY.md |
| `lint-legal.yml` | push | запрещённые строки, наличие дисклеймеров; [v3] контроль pubspec: pub-пакет kolibri не должен возвращаться (dependency_overrides git обязателен) |

Секреты: KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD, TG_API_ID, TG_API_HASH,
FDROID_REPO_KEY. [v3] Сборочные CI-джобы требуют образ ADM (self-hosted/приватный runner с
образом) — до его готовности CI-джобы сборки помечены пропускаемыми (annotate «ждёт окружение»).

---

## 8. Реестр рисков [v3 — пополнен]
| # | Риск | Вер. | Влияние | Триггер | Митигация | Владелец |
|---|---|---|---|---|---|---|
| 1–12 | (риски v2 без изменений) | | | | | |
| 13 [v3] | Дрейф форка kolibri от upstream (a6cdce9) при мерджах | средняя | среднее | upstream-мердж | тонкий слой правок (tls.rs, SessionOptions); тег-схема wellmagram/v*+N; ревью каждого bump | модель |
| 14 [v3] | Сборочный образ ADM задерживается | средняя | высокое | Т-0.1 ждёт окружение | старт без APK (код/тесты/CI-скелет); образ — внешняя зависимость с отдельным тикетом | adm |
| 15 [v3] | webpush-слой не жизнеспособен в фоне (Doze) | средняя | среднее | E7 | foreground-сервис как база; FCM (google) по ADR-0002 | модель |
| 16 [v3] | komet_crypto/rlottie ломают сборку под NDK | средняя | среднее | Т-0.1 после образа | изоляция cargokit-слоёв в образе; кэш артефактов | модель |
| 17 [v3] | Двухместная синхронизация опкодов (Dart opcode_map ↔ Rust opcodes.rs) расходится | средняя | среднее | апстрим-мердж | сверка таблицы опкодов при каждом мердже upstream (3.1 v3) | модель |

---

## 9. Открытые вопросы для владельца (⛔ до старта соответствующих фаз)
В1. [v3] Использование Firebase-конфигурации официального MAX (E1) и/или официального Telegram
    (E2) в flavor `google`; [v3-добавка] webpush-канал (E7) как без-FCM альтернатива —
    приоритет между FCM и webpush в google-сборке.
В2–В6 — без изменений против v2 (название/package/подпись/аккаунт; parallel; TDLib-мост;
тестовые аккаунты).
[v3-новое] В7. Утверждение схемы ADR-0000 (форк kolibri vs патчи поверх pub-пакета) — вынесено в
этот ADR; при возражении — ревизита до старта Фазы 5.

---

## 10. Definition of Done по релизам [v3-дельта]
- **0.1 (internal):** Т-0.1–Т-0.10; ADR-0001/0002 (по E1/E2/E4/E7)/0003; SECURITY.md v0.
- **0.3:** Фаза 1 закрыта [v3: включая ConnectionForegroundService и каркас NotificationCenter];
  регресс-чеклист без деградаций; unit-покрытие; [v3] pub-зависимость kolibri замещена форком.
- **0.5:** Telegram-вход и чаты (текст) в единном списке; foss foreground-сервис; два TG + два
  MAX аккаунта одновременно; [v3] уведомления через NotificationCenter (база — Фаза 1).
- **0.8:** медиа/голос TG; уведомления достроены (quick reply, decline, группировка); Фаза 5
  закрыта [v3: S6-гейт и SPKI в форке kolibri, cargo-тесты в CI]; собственный F-Droid-репозиторий.
- **1.0:** C1–C6; документация; подачи в Play/Galaxy/F-Droid; регистрация в Developer Console.

---

## Приложение A — Источники
- [v3] Сверка кода (источник правок плана):
  /srv/dev/OPE-2270/plan-vs-code-reconciliation-20260919.md (копия: docs/сверка/plan-vs-code-reconciliation-20260919.md);
  клоны: /srv/dev/research/komet-main (Komet main 1ae0731), /srv/dev/research/kolibri (a6cdce9).
- Источники v2 (Komet, Avenarius, rumax/PyMax/maxplus, Telegram terms, TDLib-пакеты, Play,
  RuStore, верификация, Work Profile, аналоги) — перечень ссылок без изменений против v2
  (приложение A плана v2, проверены 2026-09-03).

## Приложение B — Стартовый промпт для исполняющей модели
Без изменений против v2 (B.1 системная часть с [v3]-правками: «Не трогай lib/backend,
lib/core/protocol, lib/core/transport, native/komet_crypto, third_party/rlottie без явного
разрешения; правки Rust-ядра kolibri — только через задачи ADR-0000 (S6-гейт, SPKI-пиннинг,
bind-interface) в форке kolibri, отдельной веткой, с cargo-тестами»; B.2/B.3 — без изменений).

## Приложение C — Глоссарий [v3-пополнен]
- **kolibri** — Rust-ядро транспорта Komet (pub-пакет KometTeam/kolibri; для wellmagram —
  собственный форк по ADR-0000): rustls, MessagePack, опкоды; обёртки kolibri-dart/kotlin/swift/
  py/go через flutter_rust_bridge 2.12.0 / cargokit.
- **SessionOptions** — структура kolibri (Dart/Rust) параметров сессии: host, port, deviceId,
  deviceType/osVersion/screen/timezone/locale/deviceName/arch, proxy, insecureTls и др.; спуф
  подаётся полями, отдельного spoofScope-поля нет.
- **webpush-слой** — upstream-механизм MAX: WebPush-подписка (endpoint+authKey+publicKey) через
  Opcode.config по wss://api.oneme.ru/websocket (кандидат на доставку без FCM, E7).
- **digital-id** — модуль Komet (ext-api.max.ru, digital-id.max.ru): взаимодействие с
  digital-id-сервисом MAX; новый в плане v3.
- **komet_crypto** — Rust-крейт Komet (native/komet_crypto, cargokit): Argon2id +
  ChaCha20-Poly1305, Cyrillic base32.
- (позиции v2: Api, Opcode.config, spoofScope, switch/parallel, TDLib, Ghost mode, FGS
  remoteMessaging, limited distribution account, Obtainium)
