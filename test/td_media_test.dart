library;

import 'dart:async';

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_media.dart';

import 'mock_td_client.dart';

Map<String, dynamic> fileJson({
  int id = 17,
  int expected = 1000,
  int downloaded = 0,
  bool completed = false,
  String path = '',
}) =>
    {
      '@type': 'file',
      'id': id,
      'expected_size': expected,
      'local': {
        '@type': 'localFile',
        'path': path,
        'is_downloading_active': !completed,
        'is_downloading_completed': completed,
        'downloaded_size': downloaded,
      },
      'remote': {
        '@type': 'remoteFile',
        'id': 'remote-17',
        'is_uploading_completed': true,
      },
    };

void emitFileUpdate(MockTdClient mock, Map<String, dynamic> file) {
  mock.emitUpdate({
    '@type': 'updateFile',
    'file': file,
  });
}

void main() {
  group('TdMediaProgress extraction', () {
    test('progressOf maps updateFile to downloaded/expected', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);
      final progress = media.progressOf({
        '@type': 'updateFile',
        'file': fileJson(downloaded: 400, expected: 1000),
      });
      expect(progress?.fileId, 17);
      expect(progress?.downloaded, 400);
      expect(progress?.expected, 1000);
      expect(progress?.isCompleted, isFalse);
      expect(progress?.fraction, closeTo(0.4, 0.001));
    });

    test('non-updateFile or broken shapes → null', () {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);
      expect(media.progressOf({'@type': 'updateOption'}), isNull);
      expect(media.progressOf({'@type': 'updateFile', 'file': null}), isNull);
      expect(media.progressOfFile({'@type': 'file'}), isNull);
    });

    test('completed file: fraction 1.0 / null expected', () {
      final media = TdMedia(bridge: TdBridge(client: MockTdClient()));
      final done = media.progressOfFile(fileJson(
        downloaded: 1000,
        expected: 1000,
        completed: true,
      ));
      expect(done?.isCompleted, isTrue);
      expect(done?.fraction, 1.0);
      final unknown = media.progressOfFile(fileJson(expected: 0));
      expect(unknown?.fraction, isNull);
    });
  });

  group('TdMedia.download', () {
    test('sends the schema-shaped downloadFile request', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final call = media.download(17, priority: 16, limit: 512);
      mock.answerLast(fileJson(downloaded: 0));
      final file = await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'downloadFile');
      expect(request['file_id'], 17);
      expect(request['priority'], 16);
      expect(request['offset'], 0);
      expect(request['limit'], 512);
      expect(request['synchronous'], false);
      expect(file['id'], 17);
    });

    test('cancelDownload sends cancelDownloadFile', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final call = media.cancelDownload(17);
      mock.answerLast();
      await call;
      expect(mock.sentRequests.single['@type'], 'cancelDownloadFile');
      expect(mock.sentRequests.single['only_if_pending'], false);
    });
  });

  group('TdMedia.readFilePart', () {
    test('returns the base64 data string', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final call = media.readFilePart(17, offset: 4, count: 8);
      mock.answerLast({
        '@type': 'data',
        'data': 'QUJDREVG',
        '@extra': mock.sentRequests.single['@extra'],
      });
      expect(await call, 'QUJDREVG');
      expect(mock.sentRequests.single['@type'], 'readFilePart');
      expect(mock.sentRequests.single['offset'], 4);
      expect(mock.sentRequests.single['count'], 8);
    });

    test('empty data → null (end of file)', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final call = media.readFilePart(17);
      mock.answerLast({'@type': 'data', 'data': ''});
      expect(await call, isNull);
    });
  });

  group('TdMedia.awaitDownloaded', () {
    test('completes via updateFile progress and returns the path', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final future = media.awaitDownloaded(17);
      await Future<void>.delayed(Duration.zero);
      // Kick-off answer: still downloading.
      mock.answerLast(fileJson(downloaded: 300));
      emitFileUpdate(mock, fileJson(downloaded: 700));
      await Future<void>.delayed(Duration.zero);
      emitFileUpdate(
        mock,
        fileJson(downloaded: 1000, completed: true, path: '/files/17.jpg'),
      );
      expect(await future, '/files/17.jpg');
    });

    test('immediate completion short-circuits (no update needed)',
        () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final future = media.awaitDownloaded(17);
      await Future<void>.delayed(Duration.zero);
      mock.answerLast(
        fileJson(downloaded: 1000, completed: true, path: '/files/17.jpg'),
      );
      expect(await future, '/files/17.jpg');
    });

    test('timeout on a stalled download fails the future', () async {
      final mock = MockTdClient();
      final bridge = TdBridge(client: mock);
      final media = TdMedia(bridge: bridge);

      final future = media.awaitDownloaded(
        17,
        timeout: const Duration(milliseconds: 50),
      );
      await Future<void>.delayed(Duration.zero);
      mock.answerLast(fileJson(downloaded: 100));
      await expectLater(future, throwsA(isA<TimeoutException>()));
    });
  });

  group('TdMedia upload seam', () {
    test('inputFileLocal carries the path', () {
      final media = TdMedia(bridge: TdBridge(client: MockTdClient()));
      final input = media.inputFileLocal('/tmp/pic.jpg');
      expect(input['@type'], 'inputFileLocal');
      expect(input['path'], '/tmp/pic.jpg');
    });
  });
}
