/// In-memory [SecureStorageLike] fake for unit tests.
library;

import 'package:wellmagram/core/accounts/credential_store.dart';

class InMemorySecureStorage implements SecureStorageLike {
  final Map<String, String> data = {};

  int writeCount = 0;
  int deleteCount = 0;

  @override
  Future<String?> read({required String key}) async => data[key];

  @override
  Future<void> write({required String key, required String value}) async {
    data[key] = value;
    writeCount++;
  }

  @override
  Future<void> delete({required String key}) async {
    data.remove(key);
    deleteCount++;
  }

  @override
  Future<bool> containsKey({required String key}) async => data.containsKey(key);

  @override
  Future<Map<String, String>> readAll() async => Map.of(data);
}
