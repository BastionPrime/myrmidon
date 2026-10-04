import { 
  InstanceSettings, 
  CompanySettings,
  getEffectiveValue,
  SettingSource,
  AuditLogEntry
} from '../settings';

// Telegram DM Conversations
export const TELEGRAM_DM_CONVERSATIONS_ENV = 'MYRMIDON_TELEGRAM_DM_CONVERSATIONS';
export const TELEGRAM_DM_STATUS_ENV = 'MYRMIDON_TELEGRAM_DM_STATUS';

// Telegram Limits
export const TELEGRAM_SPLIT_MAX_PARTS_ENV = 'MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS';
export const TELEGRAM_FILE_LIMIT_BYTES_ENV = 'MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES';
export const PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV = 'PAPERCLIP_ATTACHMENT_MAX_BYTES';

// Cross-channel settings
export const CHAT_CROSS_CHANNEL_MESSAGES_ENV = 'MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES';
export const CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV = 'MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS';
export const CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV = 'MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS';
export const CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV = 'MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS';

// Chat reconciliation
export const CHAT_RECONCILE_INTERVAL_MS_ENV = 'MYRMIDON_CHAT_RECONCILE_INTERVAL_MS';

// Env-infra (read-only with status)
export const TELEGRAM_API_BASE_URL_ENV = 'TELEGRAM_API_BASE_URL';

export interface ChannelSettings {
  telegramDmConversations: {
    value: string;
    source: SettingSource;
    default: string;
    envName: string;
    overridden: boolean;
  };
  telegramDmStatus: {
    value: boolean;
    source: SettingSource;
    default: boolean;
    envName: string;
    overridden: boolean;
  };
  telegramSplitMaxParts: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  telegramFileLimitBytes: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  paperclipAttachmentMaxBytes: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  chatCrossChannelMessages: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  chatCrossChannelMessageChars: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  chatCrossChannelTotalChars: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  chatCrossChannelLookbackHours: {
    value: number;
    source: SettingSource;
    default: number;
    envName: string;
    overridden: boolean;
  };
  chatReconcileIntervalMs: {
    value: number | null;
    source: SettingSource;
    default: number | null;
    envName: string;
    overridden: boolean;
  };
  telegramApiBaseUrl: {
    value: string | null;
    source: SettingSource;
    default: string | null;
    envName: string;
    overridden: boolean;
  };
}

export interface ChannelSettingsUpdate {
  telegramDmConversations?: string;
  telegramDmStatus?: boolean;
  telegramSplitMaxParts?: number;
  telegramFileLimitBytes?: number;
  paperclipAttachmentMaxBytes?: number;
  chatCrossChannelMessages?: number;
  chatCrossChannelMessageChars?: number;
  chatCrossChannelTotalChars?: number;
  chatCrossChannelLookbackHours?: number;
  chatReconcileIntervalMs?: number | null;
}

export interface ChannelSettingsAuditEntry extends AuditLogEntry {
  field: keyof ChannelSettingsUpdate;
  oldValue: any;
  newValue: any;
}

// Default values
const DEFAULT_TELEGRAM_DM_CONVERSATIONS = '';
const DEFAULT_TELEGRAM_DM_STATUS = false;
const DEFAULT_TELEGRAM_SPLIT_MAX_PARTS = 0;
const DEFAULT_TELEGRAM_FILE_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES = 12;
const DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS = 600;
const DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS = 4000;
const DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS = 168; // 7 days
const DEFAULT_CHAT_RECONCILE_INTERVAL_MS: number | null = null;

export function getEffectiveChannelSettings(
  instanceSettings: InstanceSettings | null,
  companySettings: CompanySettings | null,
  env: Record<string, string | undefined> = process.env
): ChannelSettings {
  return {
    telegramDmConversations: getEffectiveValue(
      'channel.telegramDmConversations',
      instanceSettings,
      companySettings,
      env[TELEGRAM_DM_CONVERSATIONS_ENV],
      DEFAULT_TELEGRAM_DM_CONVERSATIONS,
      TELEGRAM_DM_CONVERSATIONS_ENV,
      (value) => typeof value === 'string' ? value : DEFAULT_TELEGRAM_DM_CONVERSATIONS
    ),
    telegramDmStatus: getEffectiveValue(
      'channel.telegramDmStatus',
      instanceSettings,
      companySettings,
      env[TELEGRAM_DM_STATUS_ENV],
      DEFAULT_TELEGRAM_DM_STATUS,
      TELEGRAM_DM_STATUS_ENV,
      (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const trimmed = value.trim().toLowerCase();
          return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
        }
        return DEFAULT_TELEGRAM_DM_STATUS;
      }
    ),
    telegramSplitMaxParts: getEffectiveValue(
      'channel.telegramSplitMaxParts',
      instanceSettings,
      companySettings,
      env[TELEGRAM_SPLIT_MAX_PARTS_ENV],
      DEFAULT_TELEGRAM_SPLIT_MAX_PARTS,
      TELEGRAM_SPLIT_MAX_PARTS_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_TELEGRAM_SPLIT_MAX_PARTS : Math.max(0, parsed);
        }
        return DEFAULT_TELEGRAM_SPLIT_MAX_PARTS;
      }
    ),
    telegramFileLimitBytes: getEffectiveValue(
      'channel.telegramFileLimitBytes',
      instanceSettings,
      companySettings,
      env[TELEGRAM_FILE_LIMIT_BYTES_ENV],
      DEFAULT_TELEGRAM_FILE_LIMIT_BYTES,
      TELEGRAM_FILE_LIMIT_BYTES_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_TELEGRAM_FILE_LIMIT_BYTES : Math.max(0, parsed);
        }
        return DEFAULT_TELEGRAM_FILE_LIMIT_BYTES;
      }
    ),
    paperclipAttachmentMaxBytes: getEffectiveValue(
      'channel.paperclipAttachmentMaxBytes',
      instanceSettings,
      companySettings,
      env[PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV],
      DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES,
      PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES : Math.max(0, parsed);
        }
        return DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES;
      }
    ),
    chatCrossChannelMessages: getEffectiveValue(
      'channel.chatCrossChannelMessages',
      instanceSettings,
      companySettings,
      env[CHAT_CROSS_CHANNEL_MESSAGES_ENV],
      DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES,
      CHAT_CROSS_CHANNEL_MESSAGES_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES : Math.max(0, parsed);
        }
        return DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES;
      }
    ),
    chatCrossChannelMessageChars: getEffectiveValue(
      'channel.chatCrossChannelMessageChars',
      instanceSettings,
      companySettings,
      env[CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV],
      DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS,
      CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS : Math.max(0, parsed);
        }
        return DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS;
      }
    ),
    chatCrossChannelTotalChars: getEffectiveValue(
      'channel.chatCrossChannelTotalChars',
      instanceSettings,
      companySettings,
      env[CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV],
      DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS,
      CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS : Math.max(0, parsed);
        }
        return DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS;
      }
    ),
    chatCrossChannelLookbackHours: getEffectiveValue(
      'channel.chatCrossChannelLookbackHours',
      instanceSettings,
      companySettings,
      env[CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV],
      DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS,
      CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV,
      (value) => {
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS : Math.max(0, parsed);
        }
        return DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS;
      }
    ),
    chatReconcileIntervalMs: getEffectiveValue(
      'channel.chatReconcileIntervalMs',
      instanceSettings,
      companySettings,
      env[CHAT_RECONCILE_INTERVAL_MS_ENV],
      DEFAULT_CHAT_RECONCILE_INTERVAL_MS,
      CHAT_RECONCILE_INTERVAL_MS_ENV,
      (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number') return Math.max(0, value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) || parsed <= 0 ? null : parsed;
        }
        return DEFAULT_CHAT_RECONCILE_INTERVAL_MS;
      }
    ),
    telegramApiBaseUrl: getEffectiveValue(
      'channel.telegramApiBaseUrl',
      instanceSettings,
      companySettings,
      env[TELEGRAM_API_BASE_URL_ENV],
      null, // Default is null for read-only infra settings
      TELEGRAM_API_BASE_URL_ENV,
      (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        return null;
      },
      true // readOnly flag for infrastructure settings
    )
  };
}