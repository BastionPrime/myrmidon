library;

import 'package:test/test.dart';
import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_media.dart';
import 'package:wellmagram/core/backends/telegram/td_messages.dart';
import 'package:wellmagram/core/backends/telegram/td_voice.dart';

import 'mock_td_client.dart';

void main() {
  late MockTdClient mock;
  late TdBridge bridge;
  late TdVoice voice;

  setUp(() {
    mock = MockTdClient();
    bridge = TdBridge(client: mock);
    voice = TdVoice(
      bridge: bridge,
      media: TdMedia(bridge: bridge),
      messages: TdMessages(bridge: bridge),
    );
  });

  group('TdVoice.sendVoiceNote', () {
    test('sends the schema-shaped inputMessageVoiceNote payload', () async {
      final call = voice.sendVoiceNote(
        101,
        '/tmp/voice.opus',
        duration: 7,
        waveform: 'DwAOAA==',
      );
      mock.answerLast({
        '@type': 'message',
        'id': 910,
        'date': 1758383000,
      });
      final result = await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'sendMessage');
      expect(request['chat_id'], 101);
      expect(request['reply_to'], isNull);
      final content = request['input_message_content'] as Map;
      expect(content['@type'], 'inputMessageVoiceNote');
      final voiceNote = content['voice_note'] as Map;
      expect(voiceNote['@type'], 'inputVoiceNote');
      final inputFile = voiceNote['voice_note'] as Map;
      expect(inputFile['@type'], 'inputFileLocal');
      expect(inputFile['path'], '/tmp/voice.opus');
      expect(voiceNote['duration'], 7);
      expect(voiceNote['waveform'], 'DwAOAA==');
      final caption = content['caption'] as Map;
      expect(caption['@type'], 'formattedText');
      expect(caption['entities'], isEmpty);
      // self_destruct_type omitted — optional in the schema.

      expect(result.messageId, '910');
      expect(result.timestamp, 1758383000000);
    });

    test('voice with reply wraps messageReplyToMessage', () async {
      final call = voice.sendVoiceNote(
        101,
        '/tmp/voice.opus',
        duration: 5,
        replyToMessageId: 531,
      );
      mock.answerLast({'@type': 'message', 'id': 911, 'date': 1758383100});
      await call;

      final reply = mock.sentRequests.single['reply_to'] as Map;
      expect(reply['@type'], 'messageReplyToMessage');
      expect(reply['chat_id'], 101);
      expect(reply['message_id'], 531);
    });
  });

  group('TdVoice.sendVideoNote', () {
    test('sends the schema-shaped inputMessageVideoNote payload', () async {
      final call = voice.sendVideoNote(
        101,
        '/tmp/circle.mp4',
        duration: 12,
        length: 384,
      );
      mock.answerLast({'@type': 'message', 'id': 912, 'date': 1758383200});
      final result = await call;

      final request = mock.sentRequests.single;
      expect(request['@type'], 'sendMessage');
      final content = request['input_message_content'] as Map;
      expect(content['@type'], 'inputMessageVideoNote');
      final videoNote = content['video_note'] as Map;
      expect(videoNote['@type'], 'inputVideoNote');
      final inputFile = videoNote['video_note'] as Map;
      expect(inputFile['@type'], 'inputFileLocal');
      expect(inputFile['path'], '/tmp/circle.mp4');
      expect(videoNote['duration'], 12);
      expect(videoNote['length'], 384);

      expect(result.messageId, '912');
      expect(result.timestamp, 1758383200000);
    });
  });

  group('incoming note parsing', () {
    test('voiceNoteDuration reads messageVoiceNote.duration', () {
      final duration = voice.voiceNoteDuration({
        'content': {
          '@type': 'messageVoiceNote',
          'voice_note': {
            'duration': 9,
            'waveform': 'DwA=',
            'voice': {'@type': 'file', 'id': 21},
          },
        },
      });
      expect(duration, 9);
    });

    test('videoNoteDuration reads messageVideoNote.duration', () {
      final duration = voice.videoNoteDuration({
        'content': {
          '@type': 'messageVideoNote',
          'video_note': {'duration': 14, 'length': 384},
        },
      });
      expect(duration, 14);
    });

    test('non-note / broken shapes → null', () {
      expect(voice.voiceNoteDuration({'content': null}), isNull);
      expect(
        voice.voiceNoteDuration({
          'content': {'@type': 'messageText'},
        }),
        isNull,
      );
      expect(
        voice.voiceNoteDuration({
          'content': {
            '@type': 'messageVoiceNote',
            'voice_note': {'duration': 'broken'},
          },
        }),
        isNull,
      );
      expect(voice.videoNoteDuration({'content': null}), isNull);
    });
  });
}
