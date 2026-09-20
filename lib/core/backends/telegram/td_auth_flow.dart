/// Telegram authorization flow (plan-v3 4.4 / Т-2.2) driven through the
/// TdBridge: the TDLib `updateAuthorizationState` sequence
/// waitTdlibParameters → waitEncryptionKey → waitPhoneNumber → waitCode →
/// (waitPassword | waitRegistration) → ready.
///
/// Screen contract "в стиле Komet" (login_screen.dart /
/// code_confirmation_screen.dart / password_2fa_screen.dart): the UI layer
/// observes [state] changes and submits [submitPhoneNumber] /
/// [submitCode] / [submitPassword]. Registration of NEW accounts is not
/// supported (plan 4.4 «только вход»): waitRegistration terminates the
/// flow with [TdAuthResult.registrationUnsupported].
///
/// The databaseEncryptionKey is generated once per account, stored in
/// CredentialStore (S2) and never logged.
library;

import 'dart:async';

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_client_seam.dart';

/// Screen-machine state mirroring the TDLib authorization states the UI
/// reacts to (Komet screens: phone → code → 2FA password).
enum TdAuthStep {
  /// Client created, no updateAuthorizationState seen yet.
  idle,

  /// authorizationStateWaitTdlibParameters → call setTdlibParameters.
  waitParameters,

  /// authorizationStateWaitEncryptionKey → call
  /// setDatabaseEncryptionKey (deprecated path kept for older TDLib).
  waitEncryptionKey,

  /// authorizationStateWaitPhoneNumber → login screen.
  waitPhoneNumber,

  /// authorizationStateWaitCode → code screen.
  waitCode,

  /// authorizationStateWaitPassword → 2FA screen (hint available).
  waitPassword,

  /// authorizationStateReady — the account is usable.
  ready,

  /// Terminal failure (registration unsupported / feed or request error).
  failed,
}

/// What ended the flow; carried to the UI and the account registry.
enum TdAuthResult {
  /// authorizationStateReady reached.
  authorized,

  /// authorizationStateWaitRegistration received — new-account
  /// registration is out of scope (plan 4.4: «только вход»).
  registrationUnsupported,

  /// A TDLib error/failure ended the flow (code/message logged by the
  /// bridge without content).
  error,
}

class TdAuthFlow {
  final TdBridge bridge;
  final TdClientConfig config;

  StreamSubscription<Map<String, dynamic>>? _sub;

  final _stepController = StreamController<TdAuthStep>.broadcast();
  final _resultCompleter = Completer<TdAuthResult>();

  TdAuthStep _step = TdAuthStep.idle;

  /// Password hint from authorizationStateWaitPassword (shown on the 2FA
  /// screen, Komet password_2fa_screen semantics).
  String? passwordHint;

  /// Set while a submit is in flight so the screen can disable its
  /// primary button (Komet shows a progress state on resend/submit).
  bool submitInFlight = false;

  TdAuthFlow({required this.bridge, required this.config}) {
    _sub = bridge.updates
        .where((u) => u['@type'] == 'updateAuthorizationState')
        .listen(_onAuthorizationState);
  }

  /// Current machine step (idle → … → ready | failed).
  TdAuthStep get step => _step;

  /// Step changes for the screen layer.
  Stream<TdAuthStep> get stepChanges => _stepController.stream;

  /// Completes exactly once with the terminal result.
  Future<TdAuthResult> get result => _resultCompleter.future;

  bool get isFinished => _resultCompleter.isCompleted;

  /// Drives the flow from updateAuthorizationState (auto-steps):
  /// waitTdlibParameters → setTdlibParameters, waitEncryptionKey →
  /// setDatabaseEncryptionKey, ready → authorized, waitRegistration →
  /// terminal.
  void _onAuthorizationState(Map<String, dynamic> update) {
    if (isFinished) return;
    final state = update['authorization_state'];
    if (state is! Map) return;
    final type = state['@type'];
    switch (type) {
      case 'authorizationStateWaitTdlibParameters':
        _setStep(TdAuthStep.waitParameters);
        _auto(() => bridge.applyParameters(config));
      case 'authorizationStateWaitEncryptionKey':
        _setStep(TdAuthStep.waitEncryptionKey);
        _auto(() => bridge.send({
              '@type': 'setDatabaseEncryptionKey',
              'new_encryption_key': config.databaseEncryptionKey,
            }));
      case 'authorizationStateWaitPhoneNumber':
        _setStep(TdAuthStep.waitPhoneNumber);
      case 'authorizationStateWaitCode':
        _setStep(TdAuthStep.waitCode);
      case 'authorizationStateWaitPassword':
        passwordHint = state['password_hint'] is String
            ? state['password_hint'] as String?
            : null;
        _setStep(TdAuthStep.waitPassword);
      case 'authorizationStateReady':
        _setStep(TdAuthStep.ready);
        _finish(TdAuthResult.authorized);
      case 'authorizationStateWaitRegistration':
        _finish(TdAuthResult.registrationUnsupported);
      case 'authorizationStateClosing':
      case 'authorizationStateClosed':
      case 'authorizationStateLoggingOut':
      case 'authorizationStateTerminated':
        break;
      default:
        break;
    }
  }

  void _setStep(TdAuthStep step) {
    if (_step == step) return;
    _step = step;
    if (!_stepController.isClosed) {
      _stepController.add(step);
    }
  }

  /// Auto-step request: failures terminate the flow with error (the
  /// screens do not resubmit setTdlibParameters themselves).
  Future<void> _auto(Future<Map<String, dynamic>> Function() request) async {
    try {
      await request();
    } on TdErrorException catch (e) {
      _finish(TdAuthResult.error, code: e.code, message: e.message);
    } on TdTimeoutException {
      _finish(TdAuthResult.error, code: null, message: 'request timeout');
    } on StateError {
      _finish(TdAuthResult.error, code: null, message: 'bridge destroyed');
    }
  }

  /// Phone submission from the login screen. Returns false when the flow
  /// is not in the phone step or a submit is already in flight.
  Future<bool> submitPhoneNumber(String phoneNumber) async {
    if (_step != TdAuthStep.waitPhoneNumber || submitInFlight) return false;
    submitInFlight = true;
    final ok = await _submit({
      '@type': 'setAuthenticationPhoneNumber',
      'phone_number': phoneNumber,
      'settings': {
        '@type': 'phoneNumberAuthenticationSettings',
        'allow_flash_call': false,
        'allow_missed_call': false,
        'is_current_phone_number': true,
        'allow_sms_retrieval_api': false,
      },
    });
    submitInFlight = false;
    return ok;
  }

  /// Code submission from the code-confirmation screen.
  Future<bool> submitCode(String code) async {
    if (_step != TdAuthStep.waitCode || submitInFlight) return false;
    submitInFlight = true;
    final ok = await _submit({
      '@type': 'checkAuthenticationCode',
      'code': code,
    });
    submitInFlight = false;
    return ok;
  }

  /// 2FA password submission from the password screen.
  Future<bool> submitPassword(String password) async {
    if (_step != TdAuthStep.waitPassword || submitInFlight) return false;
    submitInFlight = true;
    final ok = await _submit({
      '@type': 'checkAuthenticationPassword',
      'password': password,
    });
    submitInFlight = false;
    return ok;
  }

  /// Submission path: a TDLib error (wrong code / wrong password /
  /// PHONE_NUMBER_INVALID) is surfaced to the caller WITHOUT terminating
  /// the flow — the user stays on the screen and can retry (Komet keeps
  /// the screen with an inline error). Timeouts likewise do not end the
  /// flow. Returns true when TDLib answered ok.
  Future<bool> _submit(Map<String, dynamic> request) async {
    try {
      await bridge.send(request);
      return true;
    } on TdErrorException catch (e) {
      lastError = (e.code as int?, e.message);
      return false;
    } on TdTimeoutException {
      lastError = (null, 'request timeout');
      return false;
    } on StateError {
      // Bridge destroyed mid-submit: the flow ends as an error.
      lastError = (null, 'bridge destroyed');
      return false;
    }
  }

  /// Last TDLib error of a screen submission: (code, message) for the
  /// inline error text; the message comes from TDLib (technical), never
  /// from chat content.
  (int?, String?)? lastError;

  void _finish(
    TdAuthResult result, {
    int? code,
    String? message,
  }) {
    if (isFinished) return;
    if (result == TdAuthResult.error) {
      lastError = (code, message);
    }
    if (result != TdAuthResult.authorized) {
      _setStep(TdAuthStep.failed);
    }
    _resultCompleter.complete(result);
  }

  /// Stops listening; the bridge itself stays alive (chat phase reuses it).
  Future<void> dispose() async {
    await _sub?.cancel();
    if (!_stepController.isClosed) {
      await _stepController.close();
    }
  }
}
