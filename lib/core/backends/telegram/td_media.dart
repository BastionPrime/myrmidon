/// Media upload/download over TdBridge (plan-v3 Т-2.5): downloadFile with
/// progress from updateFile (localFile.downloaded_size/expected_size),
/// readFilePart for completed files, upload path via inputFileLocal inside
/// sendMessage payloads. Shapes follow the master td_api.tl schema
/// (machine-verified by tools/td_schema_check.py):
/// - downloadFile file_id:int32 priority:int32 offset:int53 limit:int53
///   synchronous:Bool = File;
/// - readFilePart file_id:int32 offset:int53 count:int32 = Data; (data
///   is a base64 string in the json api);
/// - updateFile file:File = Update; file.local:localFile carries
///   path/is_downloading_active/is_downloading_completed/
///   downloaded_size; file.expected_size is the total.
/// - localFile path:string … downloaded_prefix_size:int53
///   downloaded_size:int53;
/// - inputFileLocal path:string = InputFile; (upload side: the media
///   input content objects reference it; the concrete
///   inputMessagePhoto/Document/Video shapes arrive in Т-2.6/Т-2.7 —
///   here only the transfer layer).
library;

import 'dart:async';

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';

/// Progress of one file transfer (upload or download), derived from
/// updateFile: downloaded/expected bytes and completion flag. Content-free
/// (ids and sizes only — safe for logging).
class TdMediaProgress {
  final int fileId;
  final int downloaded;
  final int expected;
  final bool isCompleted;

  const TdMediaProgress({
    required this.fileId,
    required this.downloaded,
    required this.expected,
    required this.isCompleted,
  });

  double? get fraction =>
      expected > 0 ? downloaded / expected : null;
}

class TdMedia {
  final TdBridge bridge;

  TdMedia({required this.bridge});

  /// Extracts a progress snapshot from an updateFile json, or null when
  /// the update carries no local section.
  TdMediaProgress? progressOf(Map<String, dynamic> update) {
    if (update['@type'] != 'updateFile') return null;
    final file = update['file'];
    if (file is! Map) return null;
    return progressOfFile(file.cast<String, dynamic>());
  }

  /// Progress snapshot from a file json (local.downloaded_size vs
  /// file.expected_size).
  TdMediaProgress? progressOfFile(Map<String, dynamic> file) {
    final id = file['id'];
    final expected = file['expected_size'];
    final local = file['local'];
    if (id is! int || local is! Map) return null;
    final downloaded = local['downloaded_size'];
    final completed = local['is_downloading_completed'];
    return TdMediaProgress(
      fileId: id,
      downloaded: downloaded is int ? downloaded : 0,
      expected: expected is int ? expected : 0,
      isCompleted: completed == true,
    );
  }

  /// Starts a download (priority 1..32; limit 0 = whole file). The returned
  /// file json reflects the current state; progress continues via updateFile
  /// on [TdBridge.updates].
  Future<Map<String, dynamic>> download(
    int fileId, {
    int priority = 32,
    int offset = 0,
    int limit = 0,
    bool synchronous = false,
  }) =>
      bridge.send({
        '@type': 'downloadFile',
        'file_id': fileId,
        'priority': priority,
        'offset': offset,
        'limit': limit,
        'synchronous': synchronous,
      });

  /// Cancels an active download.
  Future<void> cancelDownload(int fileId) => bridge.send({
        '@type': 'cancelDownloadFile',
        'file_id': fileId,
        'only_if_pending': false,
      });

  /// Reads a byte range of a downloaded file (readFilePart → data
  /// base64 string). Returns null when the response carries no data.
  Future<String?> readFilePart(
    int fileId, {
    int offset = 0,
    int count = 1024,
  }) async {
    final response = await bridge.send({
      '@type': 'readFilePart',
      'file_id': fileId,
      'offset': offset,
      'count': count,
    });
    final data = response['data'];
    return data is String && data.isNotEmpty ? data : null;
  }

  /// The local path of a fully downloaded file (local.path when
  /// is_downloading_completed), or null.
  String? localPathOf(Map<String, dynamic> file) {
    final local = file['local'];
    if (local is! Map) return null;
    if (local['is_downloading_completed'] != true) return null;
    final path = local['path'];
    return path is String && path.isNotEmpty ? path : null;
  }

  /// Awaits the completion of a download: watches updateFile events for
  /// [fileId] until is_downloading_completed, then returns the local path.
  /// [timeout] guards a stalled transfer (TDLib sends periodic updates;
  /// a quiet network can also mean the file is already complete — the
  /// initial state is polled via downloadFile's response).
  Future<String> awaitDownloaded(
    int fileId, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final completer = Completer<String>();
    StreamSubscription<Map<String, dynamic>>? sub;
    Timer? timer;

    void completeWith(String path) {
      if (!completer.isCompleted) completer.complete(path);
    }

    sub = bridge.updates
        .where((u) => u['@type'] == 'updateFile')
        .listen((update) {
      final file = update['file'];
      if (file is! Map || file['id'] != fileId) return;
      final path = localPathOf(file.cast<String, dynamic>());
      if (path != null) completeWith(path);
    });

    timer = Timer(timeout, () {
      if (!completer.isCompleted) {
        completer.completeError(
          TimeoutException('TdMedia: download of file $fileId stalled'),
        );
      }
    });

    try {
      // Kick the transfer off and check the immediate state.
      final file = await download(fileId);
      final path = localPathOf(file);
      if (path != null) completeWith(path);
      return await completer.future;
    } finally {
      timer.cancel();
      await sub.cancel();
    }
  }

  /// Upload-side seam: the InputFile for a local path. The concrete
  /// inputMessage* content objects arrive with Т-2.6/Т-2.7; uploading is
  /// implicit in TDLib when a message with inputFileLocal is sent (TDLib
  /// uploads then, with updateFile progress on the same file object).
  Map<String, dynamic> inputFileLocal(String path) => {
        '@type': 'inputFileLocal',
        'path': path,
      };
}
