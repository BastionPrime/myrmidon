// OPE-2568 Шаг 2 — продакшн-адаптер шва TdClientLike на реальном libtdjson
// через dart:ffi (ветка (i) ADR-0001). Контракт зеркалит td_json_client.h:
// create/send/receive/execute/destroy; receive живёт в выделенном Isolate
// (заголовок запрещает receive из двух потоков одновременно), ответ в
// порядке поступления; строки освобождаются на C-стороне — буфер копируется
// в Dart до возврата из receive.
//
// Подключение: TdSessionManager.clientFactory = () => TdFfiClient(libPath).
// JNI-ветка (ii) не реализуется: живой прогон в образе (live-smoke) дал
// решающие метрики для ADR-0001 — см. docs/ADR/0001 и комментарий сдачи.
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

  final ReceivePort _port = ReceivePort();
  Isolate? _receiveIsolate;
  final _controller = StreamController<TdResponse>.broadcast();
  bool _destroyed = false;

  /// Receives forever in a dedicated isolate: the C header allows
  /// `td_json_client_receive` from a single thread only. The handle travels
  /// as its address (isolate messages must be sendable).
  static void _receiveLoop(List<Object> args) {
    final sendPort = args[0] as SendPort;
    final clientAddress = args[1] as int;
    final libPath = args[2] as String;
    final lib = DynamicLibrary.open(libPath);
    final receive = lib.lookupFunction<_ReceiveNative, _ReceiveDart>(
      'td_json_client_receive',
    );
    final handle = Pointer<Void>.fromAddress(clientAddress);
    // The isolate owns the receive thread for the client lifetime:
    // receive blocks up to 1 s per call, null answer is normal (timeout).
    while (true) {
      final result = receive(handle, 1.0);
      if (result != null) {
        final s = result.toDartString();
        if (s.isNotEmpty) {
          sendPort.send(s);
        }
      }
    }
  }

  TdFfiClient._(this._libPath, this._client, this._bindings);

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
  /// loading any library; [destroy]/[send]/[execute] throw StateError on
  /// the fake path the same way as in production. Address 0 emulates a
  /// failed create.
  @visibleForTesting
  factory TdFfiClient.forTesting({required int clientAddress}) {
    if (clientAddress == 0) {
      throw StateError('td_json_client_create returned null');
    }
    return TdFfiClient._(
      '',
      Pointer<Void>.fromAddress(clientAddress),
      _Bindings(
        send: (_, __) {},
        execute: (_, __) => null,
        destroy: (_) {},
      ),
    );
  }

  bool get _isolateStarted => _receiveIsolate != null;

  /// Starts the receive isolate lazily on the first [updateStream]
  /// subscription or [send] (unit tests that never listen keep zero
  /// native threads).
  Future<void> _ensureReceiveIsolate() async {
    if (_isolateStarted) return;
    _port.listen(_onReceivePayload);
    _receiveIsolate = await Isolate.spawn(
      _receiveLoop,
      [_port.sendPort, _client.address, _libPath],
      errorsAreFatal: false,
    );
  }

  /// Decodes one payload received from the isolate.
  void _onReceivePayload(Object? msg) {
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
    _bindings.destroy(_client);
    _receiveIsolate?.kill(priority: Isolate.immediate);
    _port.close();
    await _controller.close();
  }

  // --- test hooks -----------------------------------------------------------

  /// Feeds a payload as if the receive isolate delivered it.
  @visibleForTesting
  void debugReceiveString(String payload) {
    _onReceivePayload(payload);
  }
}
