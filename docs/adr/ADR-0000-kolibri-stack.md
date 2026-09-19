# ADR-0000: kolibri-стек — схема владения Rust-ядром для wellmagram

Дата: 2026-09-19. Статус: accepted (по сверке OPE-2270, решение владельца п.3).
Тикет: OPE-2285 (родитель OPE-2270). Сверка: /srv/dev/OPE-2270/plan-vs-code-reconciliation-20260919.md
(копия: docs/reconciliation-20260919.md в этом репозитории).

## Контекст

Upstream Komet (main 1ae0731, 2026-09-11) с сентября 2026 года держит транспорт в Rust-ядре
`kolibri` (репозиторий KometTeam/kolibri, a6cdce9, крейт kolibri-net ~4 228 строк Rust). Приложение
потребляет его как pub-пакет `kolibri: ^0.1.4` с pub.dev (pubspec.lock: source hosted, sha256
e59a5697…b370) — не git-зависимость. Оверрайдов в pubspec.yaml Komet нет (dependency_overrides
отсутствует).

Наши требования, которые невозможно выполнить поверх pub-пакета (правки должны жить в Rust-коде
ядра):

1. **S6 — компиляционный гейт dev_tls_insecure.** Сейчас `TlsConfig.isInsecureAllowed()` (Dart,
   prefs `dev_tls_insecure`) → `SessionOptions.insecureTls` → Rust `build_client_config(insecure:
   true)` → `AcceptAnyCert` («DEBUG ONLY, wide open to MitM»). Гейтов kDebugMode/kReleaseMode нет
   ни в Dart, ни в Rust: compile-time гарантии отсутствуют. Гейт обязан быть compile-time —
   значит, должен жить в Rust-ядре (cfg/feature/константа), то есть в нашем коде колибри.
2. **SPKI-пиннинг** (Т-5.3). TLS-рукопожатие целиком в kolibri-net/src/transport/tls.rs (rustls,
   ServerCertVerifier). Пиннинг = кастомный верификатор с набором SPKI-пинов, сосуществующий с
   встроенным минцифры-трастом (MINCIFRY_CA_PEM + TRUST_MINCIFRY/setTrustMincifryCa) и рядом
   AcceptAnyCert. Это правка того же файла — только в исходниках ядра.
3. **VPN bypass (open)** — если задача подтвердится (vpn_bypass.dart против Rust-сокетов), решение
   ляжет в transport/client.rs (bind_interface в SessionOptions); тоже правка ядра.

## Рассмотренные варианты

### Вариант A — патчи поверх pub-пакета (dependency_overrides + tools/pub_patch)

pub-пакет скачивается в pub-cache и патчится скриптом (классические pub-patch-подходы).
Оценка: отвергнуто. (a) Патч живёт вне git-истории пакета: нет ревью-следа, нет механизма
обновления при bump kolibri ^0.1.4 → следующую версию (sha256 в lock не сойдётся, патч молча
протухнет). (b) cargokit компилирует Rust при сборке приложения — патч исходников в pub-cache
воспроизводим только «перезапуском патчера» перед каждой сборкой; любая чистка кэша ломает
воспроизводимость, CI-кэш становится источником истины. (c) Никакой изолированной тестовой
базы для ядра (cargo test в патченном pub-cache не является частью нашего репозитория).

### Вариант B — свой форк kolibri (git-зависимость)

dependency_overrides:
  kolibri:
    git:
      url: <URL нашего форка>
      ref: <тег/ветка, пиненная на ревью>

Оценка: принят. (a) Правки Rust проходят наш нормальный путь: ветка → ревью adm-dev-review →
merge → тег → bump ref в pubspec. (b) sha256-lock не нужен: git-ref — полный источник. (c)
cargo test / cargo clippy гоняются в CI форка независимо от Flutter-сборки. (d) Мержи upstream:
kolibri публикуется из того же KometTeam/kolibri — форк отслеживает upstream, наши правки —
тонкий слой поверх (гейт, пиннинг, опции сессии), конфликты локализованы в transport/*.

### Вариант C — upstream PR (отдать правки в KometTeam/kolibri)

Оценка: отвергнуто на горизонте 1.0. С6-гейт и SPKI-пиннинг — наши требования безопасности
форка, не задачи upstream; попытка согласования с внешним проектом вносит внешнюю задержку в
критический путь security-фазы. Ревизита в будущем: после стабилизации предложить upstream
(минцифры-траст в upstream уже есть — прецедент встраивания доверия).

## Решение

1. **Komet форкаем** (ветка wellmagram от upstream main; merged-модель Komet↔wellmagram —
   периодический мердж upstream, как в плане v2).
2. **kolibri НЕ используем с pub.dev**: в wellmagram с первого дня применяется
   `dependency_overrides` с git-ссылкой на наш форк kolibri. Схема именования веток/тегов в
   форке kolibri: ветка `wellmagram/main` — наш мастер; от неё теги `wellmagram/v<upstream-
   version>+<наш patch>` (например `wellmagram/v0.1.4+1`) — на них пинится override. Чистые
   upstream-мерджи — merge upstream/main → wellmagram/main, конфликтные зоны: transport/tls.rs,
   SessionOptions (api).
3. Правки ядра в форке kolibri (в порядке фаз):
   - S6-гейт: compile-time переключатель (cargo feature или const) в kolibri-net — в
     конфигурации release insecureTls=true отклоняется (ошибка/игнор), в debug — работает.
     Покрыт unit-тестом в форке.
   - SPKI-пиннинг: extension-точка верификатора в tls.rs (пины в конфиге, «мягкий» режим из
     плана v2 сохранён) + сосуществование с минцифры-трастом.
   - (open) bind_interface для VPN bypass — отдельной задачей после живой проверки.
4. Транспортные факты (для раздела 3.1 плана v3): Rust transport = kolibri-net/src/transport/
   {client,tls,proxy,dispatcher,error,wiretap}.rs; прокси — поле `SessionOptions.proxy` (url
   `scheme://[user:pass@]host:port`, http/socks5/socks5h); Dart-side ProxyConnector не нужен.
   Числа: kolibri-net ~4 228 строк Rust; доп. слои в дереве Komet — native/komet_crypto
   (Rust/cargokit) и third_party/rlottie (submodule).

## Последствия

- Сборка wellmagram тянет Rust-инструментал (cargokit, flutter_rust_bridge 2.12.0) — требования
  к сборочному образу ADM (см. Т-0.1 v3): Rust toolchain + NDK + CMake + JDK 17, два cargokit-
  слоя (kolibri + komet_crypto), rlottie-submodule. Образ собирается инфраструктурой (adm) —
  это внешняя зависимость Фазы 0.
- Зафиксированный ref форка в pubspec — точка ревью для adm-dev-review (каждый bump = отдельный
  тикет на правку ref).
- При выпуске релиза wellmagram патчи pubspec_overrides не расходятся с pubspec.lock: в
  репозитории коммитятся оба (lock перекэшируется на git-источник).
- Риск: upstream может сменить схему потребления kolibri (перейти на git-зависимость сам) —
  отслеживается при каждом upstream-мердже; схема ADR остаётся применимой (override просто
  повторит upstream-подход).
