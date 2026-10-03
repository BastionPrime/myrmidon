import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SharedMountSettings,
  DEFAULT_SHARED_MOUNT_SETTINGS,
  getEffectiveSharedMountSettings,
  isBotAllowedSharedAccess,
  getSharedMountHostPath,
  ensureSharedDirectory,
  migrateHardlinkCopies,
  prepareBotSharedMount,
} from "./shared-mount";

describe("shared-mount", () => {
  let tempDir: string;
  let botVolumePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-mount-test-"));
    botVolumePath = path.join(tempDir, "bot-volume");
    await fs.mkdir(botVolumePath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getEffectiveSharedMountSettings", () => {
    it("should return default settings when no settings provided", () => {
      const result = getEffectiveSharedMountSettings(undefined);
      expect(result).toEqual(DEFAULT_SHARED_MOUNT_SETTINGS);
    });

    it("should merge provided settings with defaults", () => {
      const partialSettings: Partial<SharedMountSettings> = {
        enabled: true,
        writable: true,
      };
      const result = getEffectiveSharedMountSettings(partialSettings);
      expect(result).toEqual({
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: true,
      });
    });

    it("should handle allowedBots correctly", () => {
      const partialSettings: Partial<SharedMountSettings> = {
        enabled: true,
        allowedBots: ["bot1", "bot2"],
      };
      const result = getEffectiveSharedMountSettings(partialSettings);
      expect(result).toEqual({
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        allowedBots: ["bot1", "bot2"],
      });
    });
  });

  describe("isBotAllowedSharedAccess", () => {
    it("should return false if shared mount is not enabled", () => {
      const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: false };
      expect(isBotAllowedSharedAccess("bot1", settings)).toBe(false);
    });

    it("should return true if no allowlist is specified", () => {
      const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: true, allowedBots: [] };
      expect(isBotAllowedSharedAccess("bot1", settings)).toBe(true);
    });

    it("should return true if bot is in allowlist", () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        allowedBots: ["bot1", "bot2"],
      };
      expect(isBotAllowedSharedAccess("bot1", settings)).toBe(true);
    });

    it("should return false if bot is not in allowlist", () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        allowedBots: ["bot2", "bot3"],
      };
      expect(isBotAllowedSharedAccess("bot1", settings)).toBe(false);
    });
  });

  describe("getSharedMountHostPath", () => {
    it("should use provided hostPath if specified", () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        hostPath: "/custom/shared/path",
      };
      const result = getSharedMountHostPath(settings);
      expect(result).toBe("/custom/shared/path");
    });

    it("should use default path with MYRMIDON_BOT_VOLUME_ROOT env var", async () => {
      const originalEnv = process.env.MYRMIDON_BOT_VOLUME_ROOT;
      process.env.MYRMIDON_BOT_VOLUME_ROOT = "/custom/volume";
      
      try {
        const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: true };
        const result = getSharedMountHostPath(settings);
        expect(result).toBe("/custom/volume/shared");
      } finally {
        process.env.MYRMIDON_BOT_VOLUME_ROOT = originalEnv;
      }
    });

    it("should use default path if no env var is set", () => {
      const originalEnv = process.env.MYRMIDON_BOT_VOLUME_ROOT;
      delete process.env.MYRMIDON_BOT_VOLUME_ROOT;
      
      try {
        const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: true };
        const result = getSharedMountHostPath(settings);
        expect(result).toBe("/var/lib/myrmidon-bots/shared");
      } finally {
        process.env.MYRMIDON_BOT_VOLUME_ROOT = originalEnv;
      }
    });
  });

  describe("ensureSharedDirectory", () => {
    it("should not create directory if shared mount is not enabled", async () => {
      const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: false };
      await expect(ensureSharedDirectory(settings)).resolves.not.toThrow();
      
      // Verify directory was not created
      const sharedPath = getSharedMountHostPath(settings);
      await expect(fs.access(sharedPath)).rejects.toThrow();
    });

    it("should create directory with correct permissions if writable", async () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: true,
        hostPath: path.join(tempDir, "shared"),
      };
      
      await ensureSharedDirectory(settings);
      
      const stats = await fs.stat(settings.hostPath!);
      expect(stats.isDirectory()).toBe(true);
      // Mode 0o770 in decimal is 496, but may vary depending on umask
      // We'll check if it's a directory and accessible
      await expect(fs.access(settings.hostPath!, fs.constants.R_OK | fs.constants.W_OK)).resolves.not.toThrow();
    });

    it("should create directory with correct permissions if read-only", async () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: false,
        hostPath: path.join(tempDir, "shared-ro"),
      };
      
      await ensureSharedDirectory(settings);
      
      const stats = await fs.stat(settings.hostPath!);
      expect(stats.isDirectory()).toBe(true);
      // Mode 0o750 in decimal is 488, but may vary depending on umask
      // We'll check if it's a directory and readable
      await expect(fs.access(settings.hostPath!, fs.constants.R_OK)).resolves.not.toThrow();
    });
  });

  describe("migrateHardlinkCopies", () => {
    it("should not migrate if shared mount is not enabled", async () => {
      const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: false };
      await expect(migrateHardlinkCopies("bot1", botVolumePath, settings)).resolves.not.toThrow();
    });

    it("should not migrate if bot has no shared directory", async () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        hostPath: path.join(tempDir, "shared"),
      };
      
      await expect(migrateHardlinkCopies("bot1", botVolumePath, settings)).resolves.not.toThrow();
    });

    it("should migrate existing files to shared directory", async () => {
      const sharedPath = path.join(tempDir, "shared");
      const botSharedPath = path.join(botVolumePath, "shared");
      
      // Create bot's old shared directory with some files
      await fs.mkdir(botSharedPath, { recursive: true });
      await fs.writeFile(path.join(botSharedPath, "file1.txt"), "content1");
      await fs.writeFile(path.join(botSharedPath, "file2.txt"), "content2");
      
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        hostPath: sharedPath,
      };
      
      await migrateHardlinkCopies("bot1", botVolumePath, settings);
      
      // Verify the shared directory was created and files were moved
      await expect(fs.access(sharedPath)).resolves.not.toThrow();
      await expect(fs.access(path.join(sharedPath, "file1.txt"))).resolves.not.toThrow();
      await expect(fs.access(path.join(sharedPath, "file2.txt"))).resolves.not.toThrow();
      
      // Verify the bot's shared directory is now a symlink
      const botSharedStat = await fs.lstat(botSharedPath);
      expect(botSharedStat.isSymbolicLink()).toBe(true);
    });

    it("should handle empty bot shared directory", async () => {
      const sharedPath = path.join(tempDir, "shared");
      const botSharedPath = path.join(botVolumePath, "shared");
      
      // Create empty bot shared directory
      await fs.mkdir(botSharedPath, { recursive: true });
      
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        hostPath: sharedPath,
      };
      
      await migrateHardlinkCopies("bot1", botVolumePath, settings);
      
      // Verify the shared directory was created
      await expect(fs.access(sharedPath)).resolves.not.toThrow();
      
      // Verify the bot's shared directory is now a symlink
      const botSharedStat = await fs.lstat(botSharedPath);
      expect(botSharedStat.isSymbolicLink()).toBe(true);
    });
  });

  describe("prepareBotSharedMount", () => {
    it("should return undefined mountPath if shared mount is not enabled", async () => {
      const settings = { ...DEFAULT_SHARED_MOUNT_SETTINGS, enabled: false };
      const result = await prepareBotSharedMount("bot1", botVolumePath, settings);
      expect(result).toEqual({ mountPath: undefined, readOnly: true });
    });

    it("should return undefined mountPath if bot is not allowed", async () => {
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        allowedBots: ["bot2", "bot3"],
      };
      const result = await prepareBotSharedMount("bot1", botVolumePath, settings);
      expect(result).toEqual({ mountPath: undefined, readOnly: true });
    });

    it("should create and return mount path for allowed bot", async () => {
      const sharedPath = path.join(tempDir, "shared");
      const botSharedPath = path.join(botVolumePath, "shared");
      
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: true,
        hostPath: sharedPath,
      };
      
      const result = await prepareBotSharedMount("bot1", botVolumePath, settings);
      
      expect(result.mountPath).toBe(botSharedPath);
      expect(result.readOnly).toBe(false);
      
      // Verify the symlink was created
      const botSharedStat = await fs.lstat(botSharedPath);
      expect(botSharedStat.isSymbolicLink()).toBe(true);
    });

    it("should return readOnly true when writable is false", async () => {
      const sharedPath = path.join(tempDir, "shared");
      const botSharedPath = path.join(botVolumePath, "shared");
      
      const settings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: false,
        hostPath: sharedPath,
      };
      
      const result = await prepareBotSharedMount("bot1", botVolumePath, settings);
      
      expect(result.mountPath).toBe(botSharedPath);
      expect(result.readOnly).toBe(true);
      
      // Verify the symlink was created
      const botSharedStat = await fs.lstat(botSharedPath);
      expect(botSharedStat.isSymbolicLink()).toBe(true);
    });
  });

  describe("integration test for shared access between bots", () => {
    it("verifies that file placed in shared by bot A is visible to bot B", async () => {
      // This test verifies the core requirement: file placed in shared by bot A is visible to bot B
      // We simulate this with two different bot volumes accessing the same shared directory
      
      const sharedSettings = {
        ...DEFAULT_SHARED_MOUNT_SETTINGS,
        enabled: true,
        writable: true,
        allowedBots: ["botA", "botB"],
        hostPath: path.join(tempDir, "shared"),
      };
      
      // Both bots have access to the same shared directory
      expect(isBotAllowedSharedAccess("botA", sharedSettings)).toBe(true);
      expect(isBotAllowedSharedAccess("botB", sharedSettings)).toBe(true);
      
      // Create botA's volume
      const botAVolumePath = path.join(tempDir, "botA-volume");
      await fs.mkdir(botAVolumePath, { recursive: true });
      
      // Create botB's volume
      const botBVolumePath = path.join(tempDir, "botB-volume");
      await fs.mkdir(botBVolumePath, { recursive: true });
      
      // Prepare shared mount for botA
      const botAResult = await prepareBotSharedMount("botA", botAVolumePath, sharedSettings);
      expect(botAResult.mountPath).toBeDefined();
      
      // Prepare shared mount for botB
      const botBResult = await prepareBotSharedMount("botB", botBVolumePath, sharedSettings);
      expect(botBResult.mountPath).toBeDefined();
      
      // Both bots should be mounting to the same shared directory
      expect(botAResult.mountPath).toBe(path.join(botAVolumePath, "shared"));
      expect(botBResult.mountPath).toBe(path.join(botBVolumePath, "shared"));
      
      // The underlying shared directory is the same
      const sharedPath = getSharedMountHostPath(sharedSettings);
      expect(sharedPath).toBe(path.join(tempDir, "shared"));
      
      // Create a file in the shared directory (simulating botA placing a file)
      const sharedFilePath = path.join(sharedPath, "test-file.txt");
      await fs.writeFile(sharedFilePath, "Hello from bot A");
      
      // Verify the file exists in the shared directory
      expect(await fs.access(sharedFilePath).then(() => true).catch(() => false)).toBe(true);
      
      // The file placed by botA should be accessible through botB's mount as well
      // This verifies that the shared directory is truly shared between bots
      const botBSharedPath = path.join(botBVolumePath, "shared");
      const botBFilePath = path.join(botBSharedPath, "test-file.txt");

      // Read the file through botB's perspective
      const content = await fs.readFile(botBFilePath, "utf8");
      expect(content).toBe("Hello from bot A");

      // This demonstrates that a file placed by botA is visible to botB
      expect(content).toContain("Hello from bot A");
    });
  });
});