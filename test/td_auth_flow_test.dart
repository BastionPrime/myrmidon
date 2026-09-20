library;

import 'dart:async';

import 'package:test/test.dart';
import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:wellmagram/core/backends/telegram/td_auth_flow.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';
import 'package:wellmagram/core/backends/telegram/td_db_key_store.dart';

import 'in_memory_secure_storage.dart';
import 'mock_td_client.dart';

TdClientConfig testConfig(List<int> key) => TdClientConfig(
      databaseDirectory: '/data/tg/1/tdlib',
      filesDirectory: '/data/tg/1/files',
      databaseEncryptionKey: key,
      apiId: 1,
      apiHash: 'hash',
      systemLanguageCode: 'ru',
      deviceModel: 'Test',
      systemVersion: '1',
      applicationVersion: '0',
    );

void emitAuthState(MockTdClient mock, String type, [Map<String, dynamic>? fields]) {
  mock.emitUpdate({
    '@type': 'updateAuthorizationState',
    'authorization_state': {'@type': type, ...?fields},
  });
}

void main() {
  group('TdAuthFlow happy path (phone → code → ready)', () {
    test('auto-steps parameters/encryptionKey, waits for phone', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1, 2, 3]));
      emitAuthState(mock, 'authorizationStateWaitTdlibParameters');
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.waitParameters);
      expect(
        mock.sentRequests.map((r) => r['@type']),
        contains('setTdlibParameters'),
      );
      mock.answerLast();
      emitAuthState(mock, 'authorizationStateWaitEncryptionKey');
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.waitEncryptionKey);
      expect(
        mock.sentRequests.map((r) => r['@type']),
        contains('setDatabaseEncryptionKey'),
      );
      mock.answerLast();
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.waitPhoneNumber);
      await flow.dispose();
      await bridge.destroy();
    });

    test('full login: phone → code → ready', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1]));
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);

      final phoneCall = flow.submitPhoneNumber('+70000000001');
      mock.answerLast();
      final phoneOk = await phoneCall;
      expect(phoneOk, isTrue);
      expect(
        mock.sentRequests.last['@type'],
        'setAuthenticationPhoneNumber',
      );
      expect(mock.sentRequests.last['phone_number'], '+70000000001');
      // TDLib confirms the phone: next state is waitCode.
      mock.answerLast();
      emitAuthState(mock, 'authorizationStateWaitCode');
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.waitCode);

      final codeCall = flow.submitCode('54321');
      mock.answerLast();
      final codeOk = await codeCall;
      expect(codeOk, isTrue);
      expect(mock.sentRequests.last['@type'], 'checkAuthenticationCode');
      expect(mock.sentRequests.last['code'], '54321');
      mock.answerLast();

      emitAuthState(mock, 'authorizationStateReady');
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.ready);
      expect(await flow.result, TdAuthResult.authorized);
      expect(flow.isFinished, isTrue);
      await flow.dispose();
      await bridge.destroy();
    });

    test('2FA path: password with hint', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1]));
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);
      final phone2Call = flow.submitPhoneNumber('+70000000002');
      mock.answerLast();
      await phone2Call;
      emitAuthState(mock, 'authorizationStateWaitCode');
      await Future<void>.delayed(Duration.zero);
      final code2Call = flow.submitCode('11111');
      mock.answerLast();
      await code2Call;
      emitAuthState(mock, 'authorizationStateWaitPassword', {
        'password_hint': 'pet name',
        'has_recovery_email_address': false,
      });
      await Future<void>.delayed(Duration.zero);
      expect(flow.step, TdAuthStep.waitPassword);
      expect(flow.passwordHint, 'pet name');

      final pwdCall = flow.submitPassword('correct horse');
      mock.answerLast();
      final ok = await pwdCall;
      expect(ok, isTrue);
      expect(
        mock.sentRequests.last['@type'],
        'checkAuthenticationPassword',
      );
      expect(mock.sentRequests.last['password'], 'correct horse');
      mock.answerLast();

      emitAuthState(mock, 'authorizationStateReady');
      expect(await flow.result, TdAuthResult.authorized);
      await flow.dispose();
      await bridge.destroy();
    });
  });

  group('TdAuthFlow negative paths', () {
    test('waitRegistration terminates with registrationUnsupported', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1]));
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);
      final phone3Call = flow.submitPhoneNumber('+70000000003');
      mock.answerLast();
      await phone3Call;
      emitAuthState(mock, 'authorizationStateWaitCode');
      await Future<void>.delayed(Duration.zero);
      final code3Call = flow.submitCode('00000');
      mock.answerLast();
      await code3Call;
      emitAuthState(mock, 'authorizationStateWaitRegistration');
      expect(await flow.result, TdAuthResult.registrationUnsupported);
      expect(flow.step, TdAuthStep.failed);
      await flow.dispose();
      await bridge.destroy();
    });

    test('wrong code is surfaced without ending the flow', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1]));
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);
      final phone4Call = flow.submitPhoneNumber('+70000000004');
      mock.answerLast();
      await phone4Call;
      emitAuthState(mock, 'authorizationStateWaitCode');
      await Future<void>.delayed(Duration.zero);

      final okCall = flow.submitCode('00000');
      mock.answerLastError(401, 'PHONE_CODE_INVALID');
      final ok = await okCall;
      expect(ok, isFalse);
      expect(flow.lastError?.$2, 'PHONE_CODE_INVALID');
      expect(flow.isFinished, isFalse, reason: 'user must be able to retry');
      // Retry with the right code succeeds.
      final retryCall = flow.submitCode('12345');
      mock.answerLast();
      final retry = await retryCall;
      expect(retry, isTrue);
      emitAuthState(mock, 'authorizationStateReady');
      expect(await flow.result, TdAuthResult.authorized);
      await flow.dispose();
      await bridge.destroy();
    });

    test('submit rejected outside its step (no double send)', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final flow = TdAuthFlow(bridge: bridge, config: testConfig([1]));
      emitAuthState(mock, 'authorizationStateWaitPhoneNumber');
      await Future<void>.delayed(Duration.zero);
      final before = mock.sentRequests.length;
      // Code submit while the flow waits for the phone: rejected.
      expect(await flow.submitCode('9999'), isFalse);
      // Password submit likewise.
      expect(await flow.submitPassword('x'), isFalse);
      expect(mock.sentRequests.length, before);
      await flow.dispose();
      await bridge.destroy();
    });
  });

  group('TdDatabaseKeyStore', () {
    final account = AccountKey(network: Network.telegram, id: 3);

    CredentialStore storeWith(InMemorySecureStorage storage) =>
        CredentialStore(storage);

    test('ensureKey generates once and is stable across reads', () async {
      final storage = InMemorySecureStorage();
      final store = TdDatabaseKeyStore(
        credentials: storeWith(storage),
        generator: () => List<int>.generate(32, (i) => (i * 7) % 256),
      );
      final first = await store.ensureKey(account);
      expect(first.length, 32);
      final second = await store.ensureKey(account);
      expect(second, equals(first));
      final readBack = await store.readKey(account);
      expect(readBack, equals(first));
    });

    test('key lands in the cred:telegram namespace (S2)', () async {
      final storage = InMemorySecureStorage();
      final store = TdDatabaseKeyStore(
        credentials: storeWith(storage),
        generator: () => List<int>.filled(32, 9),
      );
      await store.ensureKey(account);
      expect(storage.data.keys, contains('cred:tg:3'));
      final hex = storage.data['cred:tg:3']!;
      expect(hex.length, 64, reason: '32 bytes hex-encoded');
    });

    test('malformed stored value reads back as null', () async {
      final storage = InMemorySecureStorage();
      final store = TdDatabaseKeyStore(
        credentials: storeWith(storage),
        generator: () => List<int>.filled(32, 1),
      );
      storage.data['cred:tg:3'] = 'zz-not-hex';
      expect(await store.readKey(account), isNull);
      // ensureKey repairs the entry with a fresh valid key.
      final repaired = await store.ensureKey(account);
      expect(repaired.length, 32);
    });

    test('deleteKey removes the secret', () async {
      final storage = InMemorySecureStorage();
      final store = TdDatabaseKeyStore(
        credentials: storeWith(storage),
        generator: () => List<int>.filled(32, 2),
      );
      await store.ensureKey(account);
      expect(await store.deleteKey(account), isTrue);
      expect(await store.readKey(account), isNull);
    });

    test('generated keys differ between accounts (unique per account)',
        () async {
      final storage = InMemorySecureStorage();
      final store = TdDatabaseKeyStore(credentials: storeWith(storage));
      final other = AccountKey(network: Network.telegram, id: 4);
      final k1 = await store.ensureKey(account);
      final k2 = await store.ensureKey(other);
      expect(k1, isNot(equals(k2)));
    });
  });
}
