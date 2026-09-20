# ADR-0004: vpn_bypass против Rust-сокетов kolibri

Дата: 2026-09-20. Статус: accepted (код-ревью по клонам; живой тест отложен до сборочного образа).
Тикет: OPE-2342 Т-1.11 (родитель OPE-2270). План: docs/plan-v3.md строки 442–451, 456–457.
Эксперимент: docs/experiments/2026-09-20-t1-11-vpn-bypass-vs-rust-sockets.md.

## Контекст

План v3 (Т-1.11) ставил гипотезу: vpn_bypass.dart (bind-to-interface из Dart) может не работать
против сокетов, открываемых Rust-ядром kolibri — транспорт живёт в Rust
(kolibri-net/src/transport/{client,proxy}.rs), и управление сокетами из Dart недоступно. При
подтверждении планировалась правка форка kolibri: bind_interface в SessionOptions (ADR-0000 п.3,
«open»-пункт), либо снятие фичи.

## Проверка

Код-ревью трёх срезов (клоны komet-main @ 1ae0731, kolibri @ a6cdce9; живой сетевой тест в
песочнице невозможен — нет Android-рантайма/tun, зафиксировано в эксперименте):

1. vpn_bypass.dart:148 строк НЕ делает сокетного bind — это обёртка MethodChannel
   `ru.komet.app/vpn_bypass` (bind→bindToNonVpnNetwork, restoreDefault→unbindNetwork,
   shouldArm-гейт: Android + prefs + tun-детект).
2. Платформенная реализация MainActivity.kt:1049–1186 — `ConnectivityManager
   .bindProcessToNetwork(network)` (строки 1085/1168/1183): NetworkCallback с
   NET_CAPABILITY_NOT_VPN + TRANSPORT_WIFI/CELLULAR/ETHERNET, fallback-перебор getAllNetworks()
   со скорингом. Это ПРОЦЕСС-уровневая привязка (Android API 23+), а не SO_BINDTODEVICE.
3. Rust-сокеты kolibri: Client::connect_with_tap → connect_tcp → `TcpStream::connect`
   (proxy.rs:82/87) через libc; socket2/SO_BINDTODEVICE/bind_to_device в kolibri-net — 0
   совпадений; собственные DNS-резолверы отсутствуют. Порядок в api.dart: bind (строка 148)
   ДО session.connect() (строка 170) — сокет Rust открывается уже под процесс-привязкой.

## Решение

**Вариант «работает как есть».** Гипотеза не подтвердилась: bindProcessToNetwork действует на
все сокеты, открытые процессом после привязки, независимо от рантайма (ART/Rust/tokio/libc).
Правка ядра kolibri (bind_interface в SessionOptions, ADR-0000 п.3 «open»-пункт) НЕ требуется —
закрываю этот open-пункт как неактуальный. vpn_bypass.dart переносится в wellmagram как есть
(«замороженный» путь по плану п.1), интеграция в connect-оркестратор — по паттерну api.dart:115–
180 (shouldArm→bind→connect→finally restoreDefault) при подключении живого бэкенда в сборочном
образе.

## Ограничения (принятые)

- **Привязка на установление, не на жизнь сессии**: restoreDefault снимает привязку после
  хэндшейка (api.dart:178); внутренние Rust-реконнекты supervisor-а (manager.rs:229–238) открывают
  новый сокет уже по системному (VPN) маршруту. Обход VPN применяется к установлению соединения;
  при живом сокете разрыв/смена сети = реконнект по умолчанию. Семантика унаследована от Komet,
  изменять её Фаза 1 не планирует.
- **Proxy-режим**: при SessionOptions.proxy в обход уходит и соединение к прокси (сокет Rust
  открывается к прокси-серверу под той же привязкой). Если прокси достижим только через VPN,
  включённый обход заблокирует подключение — документированное поведение, решение оператора.
- **Lockdown-режимы** Android (профили с VPN-lockdown) могут отвергать bindProcessToNetwork —
  уже обрабатывается кодом (reason bind_rejected_maybe_lockdown, fallback-перебор).
- **Живой тест** (тун на устройстве, вывод bound-interface в лог, проверка фактического
  маршрута) — отложен до сборочного образа ADM/эмулятора: повторить чек-лист эксперимента
  docs/experiments/2026-09-20-t1-11-vpn-bypass-vs-rust-sockets.md и подтвердить/скорректировать
  статус при расхождении.

## Последствия

- Фича VPN bypass сохраняется в wellmagram без правок форка kolibri (нет отдельной задачи
  S6/bind-interface — п.3 «open» ADR-0000 закрыт настоящим ADR).
- Интеграционная точка Фазы 1/3: оркестратор connect — вызвать shouldArm/bind по паттерну
  Komet до session.connect() (уже отражено в MaxBackend/SessionManager через швы; вклейка в
  живой api — сборочный образ).
- FGS Т-1.9: смена сети при живых сессиях приводит к Rust-реконнекту без повторного bind —
  поведение фиксируется как известное ограничение (см. «Ограничения»), изменение — отдельным
  решением владельца, если потребуется обход на весь жизненный цикл сессии.
- ADR подлежит ревью adm-dev-review вместе с экспериментом; при живой проверке в образе,
  опровергающей вывод, — reopen с переходом на вариант «правка форка kolibri».
