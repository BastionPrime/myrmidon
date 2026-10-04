import { 
  getInstanceSettings, 
  getCompanySettings, 
  updateInstanceSetting, 
  updateCompanySetting,
  auditLog
} from '../settings';
import { 
  getEffectiveChannelSettings, 
  ChannelSettings, 
  ChannelSettingsUpdate,
  ChannelSettingsAuditEntry 
} from './settings';
import { getUserById } from '../../users';
import { ChatEndpoint } from '../../chat-endpoints';

export interface ChannelSettingsService {
  getSettings(companyId: string): Promise<ChannelSettings>;
  updateSettings(companyId: string, userId: string, updates: ChannelSettingsUpdate): Promise<void>;
}

export class ChannelSettingsServiceImpl implements ChannelSettingsService {
  async getSettings(companyId: string): Promise<ChannelSettings> {
    const [instanceSettings, companySettings] = await Promise.all([
      getInstanceSettings(),
      getCompanySettings(companyId)
    ]);

    return getEffectiveChannelSettings(instanceSettings, companySettings);
  }

  async updateSettings(companyId: string, userId: string, updates: ChannelSettingsUpdate): Promise<void> {
    // Validate telegramDmConversations against existing chat-endpoints if provided
    if (updates.telegramDmConversations !== undefined) {
      await this.validateTelegramDmConversations(updates.telegramDmConversations);
    }

    const currentUser = await getUserById(userId);

    // Get current settings to log changes
    const currentSettings = await this.getSettings(companyId);

    // Update each setting individually
    for (const [key, value] of Object.entries(updates)) {
      const settingKey = key as keyof ChannelSettingsUpdate;
      
      // Skip if value hasn't changed
      if (currentSettings[settingKey].value === value) continue;

      // Update the setting in company settings
      await updateCompanySetting(companyId, `channel.${settingKey}`, value);

      // Log the change
      const auditEntry: ChannelSettingsAuditEntry = {
        timestamp: new Date(),
        actor: {
          id: userId,
          name: currentUser.name,
          email: currentUser.email
        },
        action: 'update',
        field: settingKey,
        oldValue: currentSettings[settingKey].value,
        newValue: value
      };

      await auditLog(auditEntry);
    }
  }

  private async validateTelegramDmConversations(conversations: string): Promise<void> {
    if (!conversations || conversations.trim() === '') {
      return; // Empty list is valid
    }

    if (conversations.trim() === '*') {
      return; // Wildcard is valid
    }

    // Parse the comma-separated list of endpoint IDs
    const endpointIds = conversations
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);

    if (endpointIds.length === 0) {
      return; // No valid IDs is valid (empty list)
    }

    // Fetch all chat endpoints to validate IDs
    // Note: We'll need to implement the actual fetching mechanism
    // For now, we'll just validate that the IDs look like valid IDs
    for (const id of endpointIds) {
      if (!this.isValidEndpointId(id)) {
        throw new Error(`Invalid chat endpoint ID in MYRMIDON_TELEGRAM_DM_CONVERSATIONS: ${id}`);
      }
    }
  }

  private isValidEndpointId(id: string): boolean {
    // Basic validation - could be enhanced based on actual ID format
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }
}