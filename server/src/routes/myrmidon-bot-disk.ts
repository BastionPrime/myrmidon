import { Router, type Request, type Response } from "express";
import { z } from 'zod';
import { BotDiskSettingsSchema, DEFAULT_BOT_DISK_SETTINGS, DEFAULT_BOT_DISK_LIFECYCLE_SETTINGS } from '../myrmidon/bot-containers/lifecycle-settings.js';

// Simple in-memory storage for settings (in production, this would be stored in DB)
let currentBotDiskSettings = { ...DEFAULT_BOT_DISK_SETTINGS };

export default function myrmidonBotDiskRoutes() {
  const router = Router();

  // GET endpoint to retrieve current bot disk settings
  router.get('/', (req: Request, res: Response) => {
    res.json(currentBotDiskSettings);
  });

  // PATCH endpoint to update bot disk settings
  router.patch('/', (req: Request, res: Response) => {
    try {
      // Validate the incoming settings
      const validatedData = BotDiskSettingsSchema.parse(req.body);

      // Merge with existing settings
      currentBotDiskSettings = {
        ...currentBotDiskSettings,
        ...validatedData,
      };

      // Return the full settings object after update
      res.json(currentBotDiskSettings);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Invalid settings provided',
          details: error.flatten(),
        });
      } else {
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    }
  });

  return router;
}

export function myrmidonBotDiskLifecycleRoutes(_db: unknown) {
  // myrmidon(OPE-4021): mounted by app.ts under /api — routes below are
  // relative to it (GET/PATCH /api/myrmidon/bot-disk).
  const router = Router();

  // Mount the bot disk lifecycle routes
  router.use('/myrmidon/bot-disk', myrmidonBotDiskRoutes());

  return router;
}
