// OPE-2568 Шаг 2 — unit-тесты TdFfiClient на структурном уровне без
// загрузки живой библиотеки (живой smoke — отдельный dart-run в образе,
// tool/tdlib_live_smoke.dart): контракт create/send/execute/destroy
// валидируется через injection-точку DynamicLibrary.open и фейковые
// нативные функции, поднятые dart-замыканиями.
library;

import 'dart:async';

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
}
