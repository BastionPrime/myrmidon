import { Router } from 'express';
import { channelSettingsRouter } from './routes.js';

export { 
  type ChannelSettings,
  type ChannelSettingsUpdate,
  type ChannelSettingsAuditEntry
} from './settings.js';

export { 
  ChannelSettingsService, 
  ChannelSettingsServiceImpl 
} from './service.js';

export { 
  getEffectiveChannelSettings 
} from './settings.js';

export { channelSettingsRouter } from './routes.js';

export const channelSettingsRoutes = (db: any) => {
  const router = Router();
  router.use('/api/myrmidon/channels', channelSettingsRouter);
  return router;
};

// Export the router as the default export
export default channelSettingsRouter;