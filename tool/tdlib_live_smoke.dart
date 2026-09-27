// OPE-2568 Шаг 2/3 — живой smoke updateAuthorizationState на реальном TDLib-клиенте.
// Загружает libtdjson.so (собран в wellmagram-builder:v2) через dart:ffi,
// поднимает клиент, ждёт в receive-цикле updateAuthorizationState
// (authorizationStateWaitTdlibParameters), шлёт close, уничтожает клиент.
// Контракт = шов TdClientLike (create/send/receive/execute/destroy).
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:ffi/ffi.dart';

String _toDart(Pointer<Uint8> p) {
  final bytes = <int>[];
  var i = 0;
  while (true) {
    final b = p[i];
    if (b == 0) break;
    bytes.add(b);
    i++;
  }
  return utf8.decode(bytes);
}

Pointer<Uint8> _toNative(String s) {
  final units = utf8.encode(s);
  final ptr = calloc<Uint8>(units.length + 1);
  for (var i = 0; i < units.length; i++) {
    ptr[i] = units[i];
  }
  ptr[units.length] = 0;
  return ptr;
}

void main() {
  final lib = DynamicLibrary.open('/td/libtdjson.so');

  final create =
      lib.lookupFunction<Pointer<Void> Function(), Pointer<Void> Function()>(
          'td_json_client_create');
  final send = lib.lookupFunction<
      Void Function(Pointer<Void>, Pointer<Uint8>),
      void Function(Pointer<Void>, Pointer<Uint8>)>('td_json_client_send');
  final receive = lib.lookupFunction<
      Pointer<Uint8> Function(Pointer<Void>, Double),
      Pointer<Uint8>? Function(Pointer<Void>, double)>(
      'td_json_client_receive');
  final destroy = lib
      .lookupFunction<Void Function(Pointer<Void>), void Function(Pointer<Void>)>(
          'td_json_client_destroy');

  final client = create();
  print('client created: ${client.address != 0}');

  final sw = Stopwatch()..start();
  bool sawAuthState = false;
  String firstState = '';

  final deadline = DateTime.now().add(const Duration(seconds: 15));
  while (DateTime.now().isBefore(deadline)) {
    final result = receive(client, 1.0);
    if (result != null) {
      final s = _toDart(result);
      if (s.isNotEmpty) {
        try {
          final m = jsonDecode(s) as Map<String, dynamic>;
          if (m['@type'] == 'updateAuthorizationState') {
            sawAuthState = true;
            firstState =
                (m['authorization_state'] as Map)['@type'] as String;
            print('updateAuthorizationState received: $firstState');
            print(
                'cold start to first auth update: ${sw.elapsedMilliseconds} ms');
            break;
          }
        } catch (_) {}
      }
    }
  }

  send(client, _toNative(jsonEncode({'@type': 'close'})));
  destroy(client);
  print('client destroyed');

  if (sawAuthState) {
    print('SMOKE RESULT: PASS (updateAuthorizationState=$firstState)');
    exit(0);
  } else {
    print('SMOKE RESULT: FAIL (no updateAuthorizationState within 15 s)');
    exit(1);
  }
}
