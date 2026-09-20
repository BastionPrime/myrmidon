/// Voice notes and video notes (circles) over TdBridge (plan-v3 Т-2.6):
/// inputMessageVoiceNote / inputMessageVideoNote payloads with the
/// shared TdMedia upload seam (inputFileLocal; TDLib uploads implicitly
/// when the message is sent, progress via updateFile). Shapes follow the
/// master td_api.tl schema (machine-verified by tools/td_schema_check.py):
/// - inputMessageVoiceNote voice_note:inputVoiceNote caption:formattedText
///   self_destruct_type:MessageSelfDestructType;
/// - inputVoiceNote voice_note:InputFile duration:int32 waveform:bytes
///   (waveform is a base64 string in the json api, optel-style envelope
///   of 4-bit amplitudes — synthetic in tests, produced by the Komet
///   record stack in the build image);
/// - inputMessageVideoNote video_note:inputVideoNote
///   self_destruct_type:MessageSelfDestructType;
/// - inputVideoNote video_note:InputFile thumbnail:inputThumbnail
///   duration:int32 length:int32 (square side in pixels);
/// - incoming messageVoiceNote carries voice_note.duration/waveform,
///   messageVideoNote — video_note.duration/length (mapped to Unified
///   previews by the chat store layer).
library;

import 'package:wellmagram/core/backends/telegram/td_bridge.dart';
import 'package:wellmagram/core/backends/telegram/td_media.dart';
import 'package:wellmagram/core/backends/telegram/td_messages.dart';

class TdVoice {
  final TdBridge bridge;
  final TdMedia media;
  final TdMessages messages;

  TdVoice({
    required this.bridge,
    required this.media,
    required this.messages,
  });

  /// Sends a voice note from a local file. [waveform] is the base64
  /// waveform envelope; [duration] is seconds. Returns (messageId, date).
  Future<({String messageId, int timestamp})> sendVoiceNote(
    int chatId,
    String path, {
    required int duration,
    String waveform = '',
    int? replyToMessageId,
  }) async {
    final response = await bridge.send({
      '@type': 'sendMessage',
      'chat_id': chatId,
      'reply_to': replyToMessageId == null
          ? null
          : {
              '@type': 'messageReplyToMessage',
              'chat_id': chatId,
              'message_id': replyToMessageId,
            },
      'input_message_content': {
        '@type': 'inputMessageVoiceNote',
        'voice_note': {
          '@type': 'inputVoiceNote',
          'voice_note': media.inputFileLocal(path),
          'duration': duration,
          'waveform': waveform,
        },
        'caption': {
          '@type': 'formattedText',
          'text': '',
          'entities': const [],
        },
      },
    });
    final id = response['id'];
    final date = response['date'];
    return (
      messageId: id is int ? '$id' : '',
      timestamp: date is int ? date * 1000 : 0,
    );
  }

  /// Sends a video note (circle) from a local file. [length] is the
  /// square side in pixels; [duration] is seconds. Returns (messageId,
  /// date).
  Future<({String messageId, int timestamp})> sendVideoNote(
    int chatId,
    String path, {
    required int duration,
    required int length,
    int? replyToMessageId,
  }) async {
    final response = await bridge.send({
      '@type': 'sendMessage',
      'chat_id': chatId,
      'reply_to': replyToMessageId == null
          ? null
          : {
              '@type': 'messageReplyToMessage',
              'chat_id': chatId,
              'message_id': replyToMessageId,
            },
      'input_message_content': {
        '@type': 'inputMessageVideoNote',
        'video_note': {
          '@type': 'inputVideoNote',
          'video_note': media.inputFileLocal(path),
          'duration': duration,
          'length': length,
        },
      },
    });
    final id = response['id'];
    final date = response['date'];
    return (
      messageId: id is int ? '$id' : '',
      timestamp: date is int ? date * 1000 : 0,
    );
  }

  /// Duration of an incoming messageVoiceNote (seconds), or null.
  int? voiceNoteDuration(Map<String, dynamic> message) {
    if (message['content'] is! Map) return null;
    final content = (message['content'] as Map).cast<String, dynamic>();
    if (content['@type'] != 'messageVoiceNote') return null;
    final voiceNote = content['voice_note'];
    if (voiceNote is! Map) return null;
    final duration = voiceNote['duration'];
    return duration is int ? duration : null;
  }

  /// Duration of an incoming messageVideoNote (seconds), or null.
  int? videoNoteDuration(Map<String, dynamic> message) {
    if (message['content'] is! Map) return null;
    final content = (message['content'] as Map).cast<String, dynamic>();
    if (content['@type'] != 'messageVideoNote') return null;
    final videoNote = content['video_note'];
    if (videoNote is! Map) return null;
    final duration = videoNote['duration'];
    return duration is int ? duration : null;
  }
}
