import { describe, it, beforeEach, vi, expect } from 'vitest';
import { ChannelSettingsServiceImpl } from './service';
import { 
  getEffectiveChannelSettings,
  ChannelSettings,
  ChannelSettingsUpdate
} from './settings';

// Mock dependencies
vi.mock('../settings', async () => {
  const actual = await vi.importActual('../settings');
  return {
    ...actual,
    getInstanceSettings: vi.fn().mockResolvedValue(null),
    getCompanySettings: vi.fn().mockResolvedValue(null),
    updateCompanySetting: vi.fn().mockResolvedValue(undefined),
    getUserById: vi.fn().mockResolvedValue({ id: 'user-1', name: 'Test User', email: 'test@example.com' }),
    auditLog: vi.fn().mockResolvedValue(undefined)
  };
});

describe('ChannelSettings', () => {
  let service: ChannelSettingsServiceImpl;

  beforeEach(() => {
    service = new ChannelSettingsServiceImpl();
  });

  describe('getEffectiveChannelSettings', () => {
    it('should return default values when no overrides exist', () => {
      const settings = getEffectiveChannelSettings(null, null, {});
      
      expect(settings.telegramDmConversations.value).toBe('');
      expect(settings.telegramDmStatus.value).toBe(false);
      expect(settings.telegramSplitMaxParts.value).toBe(0);
      expect(settings.telegramFileLimitBytes.value).toBe(10 * 1024 * 1024);
      expect(settings.paperclipAttachmentMaxBytes.value).toBe(10 * 1024 * 1024);
      expect(settings.chatCrossChannelMessages.value).toBe(12);
      expect(settings.chatCrossChannelMessageChars.value).toBe(600);
      expect(settings.chatCrossChannelTotalChars.value).toBe(4000);
      expect(settings.chatCrossChannelLookbackHours.value).toBe(168);
      expect(settings.chatReconcileIntervalMs.value).toBeNull();
      expect(settings.telegramApiBaseUrl.value).toBeNull();
    });

    it('should return environment variable values when specified', () => {
      const env = {
        MYRMIDON_TELEGRAM_DM_CONVERSATIONS: 'endpoint1,endpoint2',
        MYRMIDON_TELEGRAM_DM_STATUS: 'true',
        MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: '5',
        MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES: '20971520', // 20MB
        PAPERCLIP_ATTACHMENT_MAX_BYTES: '5242880', // 5MB
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: '20',
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS: '1000',
        MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS: '8000',
        MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS: '84', // 3.5 days
        MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: '30000', // 30 seconds
        TELEGRAM_API_BASE_URL: 'https://api.telegram.org'
      };

      const settings = getEffectiveChannelSettings(null, null, env);

      expect(settings.telegramDmConversations.value).toBe('endpoint1,endpoint2');
      expect(settings.telegramDmStatus.value).toBe(true);
      expect(settings.telegramSplitMaxParts.value).toBe(5);
      expect(settings.telegramFileLimitBytes.value).toBe(20971520);
      expect(settings.paperclipAttachmentMaxBytes.value).toBe(5242880);
      expect(settings.chatCrossChannelMessages.value).toBe(20);
      expect(settings.chatCrossChannelMessageChars.value).toBe(1000);
      expect(settings.chatCrossChannelTotalChars.value).toBe(8000);
      expect(settings.chatCrossChannelLookbackHours.value).toBe(84);
      expect(settings.chatReconcileIntervalMs.value).toBe(30000);
      expect(settings.telegramApiBaseUrl.value).toBe('https://api.telegram.org');

      // Check that sources are properly set to 'env'
      expect(settings.telegramDmConversations.source).toBe('env');
      expect(settings.telegramDmStatus.source).toBe('env');
      expect(settings.telegramSplitMaxParts.source).toBe('env');
      expect(settings.telegramFileLimitBytes.source).toBe('env');
      expect(settings.paperclipAttachmentMaxBytes.source).toBe('env');
      expect(settings.chatCrossChannelMessages.source).toBe('env');
      expect(settings.chatCrossChannelMessageChars.source).toBe('env');
      expect(settings.chatCrossChannelTotalChars.source).toBe('env');
      expect(settings.chatCrossChannelLookbackHours.source).toBe('env');
      expect(settings.chatReconcileIntervalMs.source).toBe('env');
      expect(settings.telegramApiBaseUrl.source).toBe('env');
    });

    it('should return UI values when specified in settings', () => {
      const instanceSettings = null;
      const companySettings = {
        channel: {
          telegramDmConversations: 'ui-value'
        }
      };

      const settings = getEffectiveChannelSettings(instanceSettings, companySettings, {});

      expect(settings.telegramDmConversations.value).toBe('ui-value');
      expect(settings.telegramDmConversations.source).toBe('ui');
    });

    it('should prioritize env over UI values', () => {
      const instanceSettings = null;
      const companySettings = {
        channel: {
          telegramDmConversations: 'ui-value'
        }
      };
      const env = {
        MYRMIDON_TELEGRAM_DM_CONVERSATIONS: 'env-value'
      };

      const settings = getEffectiveChannelSettings(instanceSettings, companySettings, env);

      expect(settings.telegramDmConversations.value).toBe('env-value');
      expect(settings.telegramDmConversations.source).toBe('env');
      expect(settings.telegramDmConversations.overridden).toBe(true);
    });
  });

  describe('ChannelSettingsService', () => {
    it('should validate telegram DM conversations format', async () => {
      // Valid formats
      await expect(service['validateTelegramDmConversations']('')).resolves.not.toThrow();
      await expect(service['validateTelegramDmConversations']('  ')).resolves.not.toThrow();
      await expect(service['validateTelegramDmConversations']('*')).resolves.not.toThrow();
      await expect(service['validateTelegramDmConversations']('endpoint1')).resolves.not.toThrow();
      await expect(service['validateTelegramDmConversations']('endpoint1,endpoint2')).resolves.not.toThrow();
      await expect(service['validateTelegramDmConversations'](' endpoint1 , endpoint2 ')).resolves.not.toThrow();
      
      // Invalid format should throw
      await expect(service['validateTelegramDmConversations']('invalid/id')).rejects.toThrow();
      await expect(service['validateTelegramDmConversations']('endpoint with spaces')).rejects.toThrow();
    });
  });

  describe('Boolean conversion', () => {
    it('should correctly convert various boolean string representations', () => {
      const testCases = [
        { input: '1', expected: true },
        { input: 'true', expected: true },
        { input: 'TRUE', expected: true },
        { input: 'True', expected: true },
        { input: 'yes', expected: true },
        { input: 'YES', expected: true },
        { input: '0', expected: false },
        { input: 'false', expected: false },
        { input: 'FALSE', expected: false },
        { input: 'no', expected: false },
        { input: 'NO', expected: false },
        { input: '', expected: false },
        { input: 'invalid', expected: false },
      ];

      testCases.forEach(({ input, expected }) => {
        const env = { MYRMIDON_TELEGRAM_DM_STATUS: input };
        const settings = getEffectiveChannelSettings(null, null, env);
        expect(settings.telegramDmStatus.value).toBe(expected);
      });
    });
  });

  describe('Numeric conversion', () => {
    it('should correctly convert numeric string representations', () => {
      const env = {
        MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: '10',
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: '25',
        MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: '60000'
      };

      const settings = getEffectiveChannelSettings(null, null, env);
      expect(settings.telegramSplitMaxParts.value).toBe(10);
      expect(settings.chatCrossChannelMessages.value).toBe(25);
      expect(settings.chatReconcileIntervalMs.value).toBe(60000);
    });

    it('should handle invalid numeric values gracefully', () => {
      const env = {
        MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS: 'invalid',
        MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES: '-5',
        MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: '0'
      };

      const settings = getEffectiveChannelSettings(null, null, env);
      expect(settings.telegramSplitMaxParts.value).toBe(0); // default
      expect(settings.chatCrossChannelMessages.value).toBe(0); // min value
      expect(settings.chatReconcileIntervalMs.value).toBeNull(); // special handling
    });
  });
});