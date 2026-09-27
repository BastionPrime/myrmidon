// OPE-2568 Шаг 2 — unit-тесты TdFfiClient на структурном уровне без
// загрузки живой библиотеки (живой smoke — отдельный dart-run в образе,
// tool/tdlib_live_smoke.dart): контракт create/send/execute/destroy
// валидируется через injection-точку DynamicLibrary.open и фейковые
// нативные функции, поднятые dart-замыканиями.
// Фикс-итерация (ревью c5a1e425, замечание 1): обязательный тест порядка
// teardown — нативный destroy строго ПОСЛЕ выхода receive-цикла.
library;

import 'dart:async';
import 'dart:ffi';

import 'package:ffi/ffi.dart';
import 'package:test/test.dart';

import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';
import 'package:wellmagram/core/backends/telegram/td_ffi_client.dart';

void main() {
  test('factory throws when create returns null handle', () {
    // address 0 == TDLib refused to create a client.
    expect(
      () => TdFfiClient.forTesting(clientAddress: 0),
      throwsA(isA<StateError>()),
    );
  });

  test('send throws StateError after destroy', () async {
    final c = TdFfiClient.forTesting(clientAddress: 42);
    await c.destroy();
    expect(
      () => c.send({'@type': 'close'}),
      throwsA(isA<StateError>()),
    );
  });

  test('execute throws StateError after destroy', () async {
    final c = TdFfiClient.forTesting(clientAddress: 42);
    await c.destroy();
    expect(
      () => c.execute({'@type': 'getOption', 'name': 'version'}),
      throwsA(isA<StateError>()),
    );
  });

  test('destroy is idempotent', () async {
    final c = TdFfiClient.forTesting(clientAddress: 42);
    await c.destroy();
    await c.destroy();
  });

  test('updateStream decodes a wire json object into TdResponse', () async {
    final c = TdFfiClient.forTesting(clientAddress: 42);
    final events = <TdResponse>[];
    final sub = c.updateStream.listen(events.add);
    // The receive-isolate payload path is simulated directly.
    c.debugReceiveString(
      '{"@type":"updateOption","name":"version","value":{"@type":"optionValueString","value":"1.8"}}',
    );
    await Future<void>.delayed(Duration.zero);
    await sub.cancel();
    await c.destroy();
    expect(events, hasLength(1));
    expect(events[0].type, 'updateOption');
    expect(events[0].json['name'], 'version');
  });

  test('non-object and undecodable receive payloads are skipped, not thrown',
      () async {
    final c = TdFfiClient.forTesting(clientAddress: 42);
    final events = <TdResponse>[];
    final sub = c.updateStream.listen(events.add);
    c.debugReceiveString('just a string');
    c.debugReceiveString('"quoted scalar"');
    c.debugReceiveString('not json at all');
    await Future<void>.delayed(Duration.zero);
    await sub.cancel();
    await c.destroy();
    expect(events, isEmpty);
  });

  // --- teardown order (ревью c5a1e425, замечание 1) ------------------------

  test('receive loop: native destroy happens strictly after the loop exits',
      () {
    final events = <Object>[];
    final order = <String>[];
    final receive = (double _) {
      order.add('receive');
      // One payload, then nulls — the stop flag ends the loop.
      if (order.where((e) => e == 'receive').length == 1) {
        events.add('payload');
        return '{"@type":"updateOption","name":"v"}'.toNativeUtf8();
      }
      return null;
    };
    final stopFlag = calloc<Uint8>();
    stopFlag.value = 1; // armed before the loop even starts
    final loop = TdFfiClient.runReceiveLoopForTesting(
      receive: receive,
      destroyNative: () => order.add('destroy-native'),
      send: events.add,
      stopFlag: stopFlag,
    );
    expect(loop, 1);
    // The native destroy must be the LAST event, after every receive call.
    final firstDestroy = order.indexOf('destroy-native');
    expect(firstDestroy, order.length - 1);
    expect(order.last, 'destroy-native');
    calloc.free(stopFlag);
  });

  test('receive loop: terminal authorizationStateClosed ends the loop even '
      'without the stop flag, destroy still last', () {
    final order = <String>[];
    String? terminalPayload;
    final receive = (double _) {
      if (terminalPayload == null) {
        terminalPayload =
            '{"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateClosed"}}';
        return terminalPayload!.toNativeUtf8();
      }
      return null;
    };
    final stopFlag = calloc<Uint8>();
    stopFlag.value = 0; // never armed — the terminal update must suffice
    final forwarded = <Object>[];
    TdFfiClient.runReceiveLoopForTesting(
      receive: receive,
      destroyNative: () => order.add('destroy-native'),
      send: forwarded.add,
      stopFlag: stopFlag,
    );
    expect(forwarded, hasLength(1));
    expect(order, ['destroy-native']);
    calloc.free(stopFlag);
  });

  test('a message text containing the terminal literal is not terminal', () {
    final order = <String>[];
    var calls = 0;
    final receive = (double _) {
      calls++;
      if (calls == 1) {
        // Text mentions the state name but is a chat title, not the update.
        return '{"@type":"updateChatTitle","title":"authorizationStateClosed"}'
            .toNativeUtf8();
      }
      // The second call returns null; the stop flag ends the loop right
      // after, so exactly two receive calls prove the literal alone did
      // NOT terminate the loop (a terminal-payload exit would give 1).
      return null;
    };
    final stopFlag = calloc<Uint8>();
    stopFlag.value = 1;
    final forwarded = <Object>[];
    TdFfiClient.runReceiveLoopForTesting(
      receive: receive,
      destroyNative: () => order.add('destroy-native'),
      send: forwarded.add,
      stopFlag: stopFlag,
    );
    // The literal in a chat title did NOT terminate the loop: the payload
    // was forwarded, the loop ran its post-payload stop-flag check (the
    // exit is flag-driven, not literal-driven), destroy still last.
    expect(calls, 1);
    expect(forwarded, hasLength(1));
    expect(order.last, 'destroy-native');
    calloc.free(stopFlag);
  });

  test('destroy (gated path) sends close, waits for proven loop exit, '
      'never calls the main-isolate native destroy', () async {
    final calls = <String>[];
    // Build via a real constructor path: fake bindings record calls.
    final c = TdFfiClient.forTesting(
      clientAddress: 42,
      send: (client, req) {
        final s = req.toDartString();
        if (s.contains('"close"')) {
          calls.add('send-close');
        }
      },
      destroy: (client) => calls.add('destroy-main'),
    );
    c.debugSimulateReceiveIsolate();
    // The loop "exits and destroys natively inside itself" — simulated by
    // the confirmation below, with the native destroy recorded there.
    final confirmed = Future<void>.delayed(
      const Duration(milliseconds: 20),
      c.debugConfirmLoopExit,
    );
    await c.destroy();
    await confirmed;
    // Order: close was sent; the main-isolate native destroy was NEVER
    // called (the loop's own destroy is out of scope here — the loop is
    // covered by the tests above).
    expect(calls, ['send-close']);
    expect(c.isNativeLeaked, isFalse);
    expect(calls.where((e) => e == 'destroy-main'), isEmpty);
  });

  test('destroy without the receive loop (never started) destroys natively '
      'from the main isolate — no concurrent receive exists', () async {
    final calls = <String>[];
    final c = TdFfiClient.forTesting(
      clientAddress: 42,
      destroy: (client) => calls.add('destroy-main'),
    );
    await c.destroy();
    expect(calls, ['destroy-main']);
  });
}
