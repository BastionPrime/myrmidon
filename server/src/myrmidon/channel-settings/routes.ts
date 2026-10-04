import express from 'express';
import { authenticateUser, requireCompanyAccess } from '../auth/middleware';
import { ChannelSettingsServiceImpl } from './service.js';
import { BadRequestError, ForbiddenError } from '../errors';

const service = new ChannelSettingsServiceImpl();

export const channelSettingsRouter = express.Router();

channelSettingsRouter.get('/settings', authenticateUser, requireCompanyAccess, async (req, res) => {
  const companyId = req.companyId;
  
  if (!companyId) {
    throw new ForbiddenError('Company access required');
  }

  const settings = await service.getSettings(companyId);
  res.json(settings);
});

channelSettingsRouter.patch('/settings', authenticateUser, requireCompanyAccess, async (req, res) => {
  const companyId = req.companyId;
  const userId = req.userId;
  
  if (!companyId || !userId) {
    throw new ForbiddenError('Company access and user authentication required');
  }

  const updates = req.body;

  // Validate the structure of the updates
  const allowedFields = [
    'telegramDmConversations',
    'telegramDmStatus', 
    'telegramSplitMaxParts',
    'telegramFileLimitBytes',
    'paperclipAttachmentMaxBytes',
    'chatCrossChannelMessages',
    'chatCrossChannelMessageChars',
    'chatCrossChannelTotalChars',
    'chatCrossChannelLookbackHours',
    'chatReconcileIntervalMs'
  ];

  for (const field in updates) {
    if (!allowedFields.includes(field)) {
      throw new BadRequestError(`Invalid field: ${field}`);
    }
  }

  await service.updateSettings(companyId, userId, updates);
  
  // Return updated settings
  const settings = await service.getSettings(companyId);
  res.json(settings);
});

export default channelSettingsRouter;