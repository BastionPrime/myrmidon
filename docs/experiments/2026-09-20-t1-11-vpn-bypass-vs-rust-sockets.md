# Эксперимент Т-1.11: vpn_bypass против Rust-сокетов kolibri

Дата: 2026-09-20. Ран: см. комментарий сдачи в OPE-2342. Среда: песочница vm-exec (клоны для сверки
/srv/dev/research/komet-main @ 1ae0731, /srv/dev/research/kolibri).

## Постановка

Гипотеза плана v3 (строки 442–451): «vpn_bypass.dart (bind-to-interface из Dart) может не работать
против сокетов, открываемых Rust-ядром». Требуется код-ревью механизма bind в vpn_bypass.dart
против клиентского сокета в kolibri-net/transport/client.rs и вывод в ADR-0004.

## Метод

Живой сетевой тест в песочнице невозможен (нет Android-рантайма, нет tun-интерфейсов, нет Flutter-
тулчейна). Выполнен код-ревью по трём срезам, как предписано планом: (1) механизм bind в
vpn_bypass.dart и его платформенная реализация; (2) путь открытия клиентского сокета в
kolibri-net; (3) порядок вызовов в оркестраторе сессии Komet. Каждый факт подтверждён чтением кода
с file:line (клоны research, upstream-коммиты указаны).

## Срез 1. Механизм bind в vpn_bypass.dart

vpn_bypass.dart (148 строк) НЕ открывает и не привязывает Dart-сокеты. Это тонкая обёртка над
MethodChannel `ru.komet.app/vpn_bypass` (vpn_bypass.dart:40–42):

- `bind()` → invokeMapMethod('bindToNonVpnNetwork') (vpn_bypass.dart:74–75);
- `restoreDefault()` → invokeMethod('unbindNetwork') (vpn_bypass.dart:144);
- `shouldArm()` — gate: Android + включено в prefs + активен tun (vpn_bypass.dart:64–68);
- детект tun — интерфейсный fallback через NetworkInterface.list (vpn_bypass.dart:124–134).

Платформенная реализация — MainActivity.kt (komet-main):

- bindToNonVpnNetwork (MainActivity.kt:1049): NetworkRequest с NET_CAPABILITY_INTERNET +
  NOT_VPN + TRANSPORT_WIFI/CELLULAR/ETHERNET (строки 1067–1072), в onAvailable вызывает
  `ConnectivityManager.bindProcessToNetwork(network)` (строка 1085);
- fallback по тайм-ауту 4 с — bindByEnumeration (строка 1121): перебор getAllNetworks(), жёсткий
  фильтр по отсутствию TRANSPORT_VPN, скоринг wifi 3 / ethernet 2 / cellular 1, попытка
  bindProcessToNetwork по кандидатам в порядке убывания (строки 1168–1177);
- unbindNetwork — bindProcessToNetwork(null) (строка 1183).

Ключевой факт: `ConnectivityManager.bindProcessToNetwork` — процесс-уровневая привязка Android
(API 23+). Она действует на ВСЕ сокеты, открытые процессом ПОСЛЕ привязки, независимо от того,
каким рантаймом (ART, Rust/tokio, libc) они созданы: getaddrinfo и socket()/connect() идут через
Netd процесса и используют выбранный Network. Это не SO_BINDTODEVICE на конкретном сокете.

## Срез 2. Путь клиентского сокета в kolibri-net

Session::connect (kolibri-net/src/session/manager.rs:104) запускает supervisor →
connect_and_handshake (manager.rs:240–247) → `Client::connect_with_tap` (transport/client.rs:76)
→ `connect_tcp` (transport/proxy.rs:73) → `TcpStream::connect((host, port))` (proxy.rs:82, без
прокси; :87 через прокси).

`TcpStream::connect` (std) резолвит имя и открывает сокет через libc (getaddrinfo + socket +
connect). Греп по kolibri-net: socket2, bind_to_device, SO_BINDTODEVICE — 0 совпадений: ядро НЕ
привязывает сокеты к интерфейсам само и НЕ держит собственных DNS-резолверов (tokio резолвит через
std::net::ToSocketAddrs → libc). Следовательно, сокеты Rust наследуют per-process network binding,
установленный bindProcessToNetwork.

## Срез 3. Порядок вызовов в оркестраторе сессии Komet

Api.connect (komet-main/lib/backend/api.dart, upstream 1ae0731):

1. shouldArm() с тайм-аутом 5 с (api.dart:115–119);
2. _buildSessionOptions (api.dart:139) — объект KolibriSession, сокет ещё НЕ открыт;
3. useBypass → `VpnBypassService.instance.bind()` (api.dart:148);
4. `session.connect()` (api.dart:170) — хэндшейк, ЗДЕСЬ Rust открывает сокет;
5. finally: restoreDefault() при useBypass (api.dart:176–180).

Порядок корректен: bind выполняется ДО открытия сокета Rust. Restore после установления —
привязка процесса снята, но уже открытый сокет продолжает жить на выбранной сети (привязка
процесса не закрывает существующие сокеты).

## Наблюдения/нюансы (не блокирующие вывод)

1. **Реконнекты Rust supervisor-а** (manager.rs:229–238, auto_reconnect) открывают НОВЫЕ сокеты
   после разрыва — привязка процесса в этот момент УЖЕ снята restoreDefault (api.dart:178),
   реконнект пойдёт по системному (VPN) маршруту. Это известная семантика обхода «только на
   установление соединения» — см. ADR-0004 «Ограничения».
2. **Proxy-случай**: при SessionOptions.proxy сокет Rust открывается к прокси-серверу
   (proxy.rs:87) — привязка процесса также покрывает этот сокет (в обход VPN уйдёт и трафик к
   прокси). Если прокси-сервер сам доступен только через VPN — обход соединение сломает; это
   документируемое поведение, решение оператора.
3. **Тайминг FGS Т-1.9**: wellmagram-контроллер не повторяет bind Komet (пер-аккаунтные сессии
   стартуют из Dart через те же швы) — bindProcessToNetwork действует на весь процесс, поэтому
   все per-account сессии и webpush-сокеты получают одинаковую маршрутизацию. Смена сети при
   живых сессиях = разрыв и Rust-реконнект (см. нюанс 1).
4. **Мульти-Network fallback-логика Komet** (bindByEnumeration, скоринг) остаётся эталоном; 
   wellmagram не дублирует её в Dart — используется тот же процесс-уровневый механизм.

## Вывод

Гипотеза «vpn_bypass.dart может не работать против Rust-сокетов» НЕ подтверждается кодом:
vpn_bypass.dart не делает сокетного bind, а процесс-уровневая привязка bindProcessToNetwork
действует на все сокеты процесса, включая открываемые Rust/tokio. bind предшествует открытию
сокета. Решение по варианту «работает как есть» — в ADR-0004 (docs/ADR/0004-vpn-bypass.md).

Живой тест на устройстве (тун, bind, подключение, вывод bound-interface в лог) — отложен до
сборочного образа/эмулятора, как и весь сетевой живой прием (фиксируется в комментарии сдачи).

## Артефакты сверки

- komet-main @ 1ae0731: lib/core/transport/vpn_bypass.dart; lib/backend/api.dart:85–180;
  android/app/src/main/kotlin/ru/komet/app/MainActivity.kt:1025–1186.
- kolibri @ a6cdce9: kolibri-net/src/transport/{client.rs:60–167, proxy.rs:73–102};
  kolibri-net/src/session/manager.rs:104–114, 195–308; kolibri-dart/rust/src/api/session.rs:224–237.
- grep socket2/bind_to_device/SO_BINDTODEVICE по kolibri-net — 0 совпадений.
