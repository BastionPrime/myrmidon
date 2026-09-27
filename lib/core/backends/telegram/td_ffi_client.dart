// OPE-2568 Шаг 2 — продакшн-адаптер шва TdClientLike на реальном libtdjson
// через dart:ffi (ветка (i) альтернативы ADR-0001; финальный выбор моста
// остаётся отложенным до живых метрик обеих веток — методика Т-0.6.
// Снятая живая точка: холодный старт 9 мс, FFI, прогон e82415f5, тикет
// OPE-2568. Контракт зеркалит td_json_client.h: create/send/receive/
// execute/destroy; receive живёт в выделенном Isolate (заголовок запрещает
// receive из двух потоков одновременно), ответ в порядке поступления;
// строки освобождаются на C-стороне — буфер копируется в Dart до возврата
// из receive.
//
// Teardown (ревью c5a1e425, фикс UAF): destroy() шлёт `close`, взводит
// стоп-флаг receive-цикла (проверяется между итерациями; receive-таймаут
// ≤1 с, терминальный updateAuthorizationState(authorizationStateClosed)
// завершает цикл раньше) — нативный td_json_client_destroy выполняет САМ
// receive-изолят строго ПОСЛЕ выхода из цикла: receive и destroy никогда
// не выполняются параллельно на одном клиенте (контракт заголовка; его же
// деструктор ~Client::Impl дрейнирует через receive — без пересечения).
// Выход цикла подтверждается контрольным сообщением; при таймауте 5 с —
// fail-safe: нативный клиент намеренно течёт (без UAF), изолят убивается.
//
// Подключение: TdSessionManager.clientFactory = () => TdFfiClient(libPath).
// JNI-ветка (ii) не реализована: полные метрики обеих веток (задержка
// апдейта, стабильность, экран 200 чатов) требуют аккаунт/эмулятор — вне
// образа; запись ADR-0001 — следующая подзадача (текущее состояние: FFI —
// рабочая реализация ветки (i)).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:isolate';

import 'package:ffi/ffi.dart';
import 'package:meta/meta.dart';

import 'td_client_seam.dart';

// --- native signatures -----------------------------------------------------

typedef _CreateNative = Pointer<Void> Function();
typedef _CreateDart = Pointer<Void> Function();
typedef _SendNative = Void Function(Pointer<Void>, Pointer<Utf8>);
typedef _SendDart = void Function(Pointer<Void>, Pointer<Utf8>);
typedef _ReceiveNative = Pointer<Utf8> Function(Pointer<Void>, Double);
typedef _ReceiveDart = Pointer<Utf8>? Function(Pointer<Void>, double);
typedef _ExecuteNative = Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>);
typedef _ExecuteDart = Pointer<Utf8>? Function(Pointer<Void>, Pointer<Utf8>);
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);

/// Control message: the receive loop has exited AND the native destroy has
/// run inside the loop's thread. Distinct from payload strings (the loop
/// forwards only strings).
const List<int> _kTeardownDone = <int>[0];

class _Bindings {
  final _SendDart send;
  final _ExecuteDart execute;
  final _DestroyDart destroy;
  const _Bindings({
    required this.send,
    required this.execute,
    required this.destroy,
  });

  static _Bindings of(String libPath) {
    final lib = DynamicLibrary.open(libPath);
    return _Bindings(
      send: lib.lookupFunction<_SendNative, _SendDart>('td_json_client_send'),
      execute: lib.lookupFunction<_ExecuteNative, _ExecuteDart>(
          'td_json_client_execute'),
      destroy: lib.lookupFunction<_DestroyNative, _DestroyDart>(
          'td_json_client_destroy'),
    );
  }
}

class TdFfiClient implements TdClientLike {
  final String _libPath;
  final Pointer<Void> _client;
  final _Bindings _bindings;
  final Duration _teardownTimeout;

  final ReceivePort _port = ReceivePort();
  Isolate? _receiveIsolate;
  Future<void>? _spawnFuture;

  /// Stop flag shared with the receive isolate (native byte: the loop reads
  /// it synchronously between receive iterations; [destroy] arms it).
  Pointer<Uint8>? _stopFlag;

  /// Completes on [_kTeardownDone] — proven exit of the receive loop.
  Completer<void>? _loopExited;

  final _controller = StreamController<TdResponse>.broadcast();
  bool _destroyed = false;
  bool _nativeLeaked = false;

  /// Receives in a dedicated isolate: the C header allows
  /// `td_json_client_receive` from a single thread only. The handle travels
  /// as its address (isolate messages must be sendable).
  static void _receiveLoop(List<Object> args) {
    final sendPort = args[0] as SendPort;
    final clientAddress = args[1] as int;
    final libPath = args[2] as String;
    final stopFlagAddress = args[3] as int;
    final lib = DynamicLibrary.open(libPath);
    final receive = lib.lookupFunction<_ReceiveNative, _ReceiveDart>(
      'td_json_client_receive',
    );
    final destroy = lib.lookupFunction<_DestroyNative, _DestroyDart>(
      'td_json_client_destroy',
    );
    final handle = Pointer<Void>.fromAddress(clientAddress);
    final stopFlag = Pointer<Uint8>.fromAddress(stopFlagAddress);
    _runReceiveLoop(
      receive: (timeout) => receive(handle, timeout),
      destroyNative: () => destroy(handle),
      send: sendPort.send,
      stopFlag: stopFlag,
    );
    sendPort.send(_kTeardownDone);
  }

  /// The receive loop body, extracted so the teardown order is unit-tested
  /// (ревью c5a1e425: тест порядка обязателен). Forwards payloads, exits on
  /// the stop flag or on the terminal
  /// updateAuthorizationState(authorizationStateClosed) — and only THEN
  /// performs the native destroy, in this same thread: receive and destroy
  /// never overlap on one client (td_json_client.h). Returns the number of
  /// forwarded payloads.
  @visibleForTesting
  static int runReceiveLoopForTesting({
    required Pointer<Utf8>? Function(double) receive,
    required void Function() destroyNative,
    required void Function(Object) send,
    required Pointer<Uint8> stopFlag,
  }) =>
      _runReceiveLoop(
        receive: receive,
        destroyNative: destroyNative,
        send: send,
        stopFlag: stopFlag,
      );

  static int _runReceiveLoop({
    required Pointer<Utf8>? Function(double) receive,
    required void Function() destroyNative,
    required void Function(Object) send,
    required Pointer<Uint8> stopFlag,
  }) {
    var forwarded = 0;
    while (true) {
      // receive blocks up to 1 s per call; null answer is normal (timeout).
      final result = receive(1.0);
      if (result != null) {
        final s = result.toDartString();
        if (s.isNotEmpty) {
          send(s);
          forwarded++;
          if (_isTerminalClosedUpdate(s)) {
            break;
          }
        }
      }
      if (stopFlag.value == 1) {
        break;
      }
    }
    // Native teardown strictly after the loop has exited — same thread.
    destroyNative();
    return forwarded;
  }

  /// updateAuthorizationState carrying authorizationStateClosed is the
  /// terminal update after `close` (the td_json_client.h recommended
  /// teardown). Cheap literal prefilter, then a json check so a message
  /// text containing the literal is not mistaken for the terminal update.
  static bool _isTerminalClosedUpdate(String payload) {
    if (!payload.contains('"authorizationStateClosed"')) return false;
    try {
      final decoded = jsonDecode(payload);
      if (decoded is Map<String, dynamic> &&
          decoded['@type'] == 'updateAuthorizationState') {
        final state = decoded['authorization_state'];
        return state is Map<String, dynamic> &&
            state['@type'] == 'authorizationStateClosed';
      }
    } catch (_) {
      // Malformed payload is not terminal — the stop flag still ends the loop.
    }
    return false;
  }

  TdFfiClient._(this._libPath, this._client, this._bindings,
      [this._teardownTimeout = const Duration(seconds: 5)]);

  factory TdFfiClient(String libraryPath) {
    final lib = DynamicLibrary.open(libraryPath);
    final create =
        lib.lookupFunction<_CreateNative, _CreateDart>('td_json_client_create');
    final client = create();
    if (client.address == 0) {
      throw StateError('td_json_client_create returned null');
    }
    return TdFfiClient._(libraryPath, client, _Bindings.of(libraryPath));
  }

  /// Test seam: constructs a client around a fake native handle without
  /// loading any library; [send]/[execute] throw StateError on the fake
  /// path the same way as in production, [destroy]/[destroyNative]/[execute]
  /// closures record calls. Address 0 emulates a failed create.
  @visibleForTesting
  factory TdFfiClient.forTesting({
    required int clientAddress,
    void Function(Pointer<Void>, Pointer<Utf8>)? send,
    Pointer<Utf8>? Function(Pointer<Void>, Pointer<Utf8>)? execute,
    void Function(Pointer<Void>)? destroy,
    Duration teardownTimeout = const Duration(seconds: 5),
  }) {
    if (clientAddress == 0) {
      throw StateError('td_json_client_create returned null');
    }
    return TdFfiClient._(
      '',
      Pointer<Void>.fromAddress(clientAddress),
      _Bindings(
        send: send ?? (_, __) {},
        execute: execute ?? (_, __) => null,
        destroy: destroy ?? (_) {},
      ),
      teardownTimeout,
    );
  }

  /// True when the fail-safe path leaked the native client instead of
  /// destroying it (timeout waiting for the receive loop's exit).
  @visibleForTesting
  bool get isNativeLeaked => _nativeLeaked;

  /// Starts the receive isolate lazily on the first [updateStream]
  /// subscription or [send] (unit tests that never listen keep zero
  /// native threads). The stop flag and the exit handshake are armed
  /// synchronously, so a [destroy] racing the spawn still finds them.
  Future<void> _ensureReceiveIsolate() {
    final existing = _spawnFuture;
    if (existing != null) return existing;
    _port.listen(_onReceivePayload);
    final stopFlag = calloc<Uint8>();
    stopFlag.value = 0;
    _stopFlag = stopFlag;
    _loopExited = Completer<void>();
    final spawn = Isolate.spawn(
      _receiveLoop,
      [_port.sendPort, _client.address, _libPath, stopFlag.address],
      errorsAreFatal: false,
    );
    final tracked = spawn.then((isolate) {
      _receiveIsolate = isolate;
      // If destroy() armed the stop flag while spawning, the fresh loop
      // exits on its first between-iterations check; the handshake in
      // destroy() awaits the confirmation.
    });
    _spawnFuture = tracked;
    return tracked;
  }

  /// Decodes one payload received from the isolate; control messages
  /// complete the teardown handshake.
  void _onReceivePayload(Object? msg) {
    if (msg is List && msg.length == 1 && msg[0] == 0) {
      final done = _loopExited;
      if (done != null && !done.isCompleted) {
        done.complete();
      }
      return;
    }
    if (msg is String) {
      try {
        final decoded = jsonDecode(msg);
        if (decoded is Map<String, dynamic>) {
          _controller.add(TdResponse(decoded));
        }
      } catch (_) {
        // Non-object answer — skipped, per the mock seam contract.
      }
    }
  }

  @override
  void send(Map<String, dynamic> request) {
    if (_destroyed) {
      throw StateError('send after destroy');
    }
    unawaited(_ensureReceiveIsolate());
    final native = jsonEncode(request).toNativeUtf8();
    try {
      _bindings.send(_client, native.cast());
    } finally {
      calloc.free(native);
    }
  }

  @override
  TdResponse? execute(Map<String, dynamic> request) {
    if (_destroyed) {
      throw StateError('execute after destroy');
    }
    final native = jsonEncode(request).toNativeUtf8();
    try {
      final result = _bindings.execute(_client, native.cast());
      if (result == null) return null;
      final s = result.toDartString();
      if (s.isEmpty) return null;
      final decoded = jsonDecode(s);
      if (decoded is Map<String, dynamic>) return TdResponse(decoded);
      return null;
    } finally {
      calloc.free(native);
    }
  }

  @override
  Stream<TdResponse> get updateStream {
    unawaited(_ensureReceiveIsolate());
    return _controller.stream;
  }

  @override
  Future<void> destroy() async {
    if (_destroyed) return;
    _destroyed = true;
    final loopExited = _loopExited;
    if (loopExited == null) {
      // The receive loop never started (and no spawn is in flight) — no
      // concurrent receive exists, the native destroy from the main
      // isolate is safe.
      _bindings.destroy(_client);
      _port.close();
      await _controller.close();
      return;
    }
    // The receive isolate owns the native handle from here on. Ask TDLib
    // to close (the loop exits on the terminal update), arm the stop flag
    // (fallback exit: the receive timeout is ≤1 s) and wait for the loop's
    // PROVEN exit — the native destroy runs inside the loop, after it
    // stops. The main isolate never touches native memory here.
    try {
      final native = jsonEncode({'@type': 'close'}).toNativeUtf8();
      try {
        _bindings.send(_client, native.cast());
      } finally {
        calloc.free(native);
      }
    } catch (_) {
      // TDLib may already be closing — the stop flag alone ends the loop.
    }
    _stopFlag?.value = 1;
    var exited = true;
    try {
      await loopExited.future.timeout(_teardownTimeout);
    } on TimeoutException {
      // Fail-safe, no UAF: the native client is intentionally leaked —
      // killing the loop never touches native memory.
      exited = false;
      _nativeLeaked = true;
    }
    _receiveIsolate?.kill(priority: Isolate.immediate);
    if (exited) {
      // The loop has provably exited — nobody reads the flag anymore.
      calloc.free(_stopFlag!);
    } else {
      // A killed loop could still be inside native code: keep the byte.
      _stopFlag = null;
    }
    _port.close();
    await _controller.close();
  }

  // --- test hooks -----------------------------------------------------------

  /// Feeds a payload as if the receive isolate delivered it.
  @visibleForTesting
  void debugReceiveString(String payload) {
    _onReceivePayload(payload);
  }

  /// Marks the receive loop as started without spawning a real isolate:
  /// arms the stop flag and the exit handshake so unit tests can drive
  /// [destroy] on the gated (isolate) path.
  @visibleForTesting
  void debugSimulateReceiveIsolate() {
    if (_spawnFuture != null) return;
    _port.listen(_onReceivePayload);
    final stopFlag = calloc<Uint8>();
    stopFlag.value = 0;
    _stopFlag = stopFlag;
    _loopExited = Completer<void>();
    _spawnFuture = Future<void>.value();
  }

  /// The receive loop exited (and destroyed natively inside itself) —
  /// completes the handshake [destroy] is waiting for.
  @visibleForTesting
  void debugConfirmLoopExit() => _onReceivePayload(_kTeardownDone);
}
