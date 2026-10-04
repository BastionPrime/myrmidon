import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { sweepBotVolume, sweepAllBotVolumes, getDefaultLifecycleConfig } from "./draft-lifecycle.js";
import type { Stats } from "fs";
import * as path from "path";

const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  default: fsMocks,
  readdir: fsMocks.readdir,
  stat: fsMocks.stat,
  rm: fsMocks.rm,
}));

describe("Draft Lifecycle Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct default lifecycle config", () => {
    const config = getDefaultLifecycleConfig();
    expect(config).toEqual({
      enabled: true,
      idleTtlMs: 6 * 60 * 60 * 1000, // 6 hours
      defaultIdleTtlMs: 6 * 60 * 60 * 1000, // 6 hours
    });
  });

  it("should skip sweep if lifecycle is disabled", async () => {
    const config = { enabled: false, idleTtlMs: 1000, defaultIdleTtlMs: 1000 };
    const mockReaddir = fsMocks.readdir.mockResolvedValue([] as never);
    
    await sweepBotVolume("/fake/path", config);
    
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("should clean up stale directories", async () => {
    const botVolumeRoot = "/tmp/test-bots";
    const config = {
      enabled: true,
      idleTtlMs: 1000, // 1 second for testing
      defaultIdleTtlMs: 1000,
    };
    
    // Mock directory with a stale workspace directory
    const mockDirs = ["bot1", "bot2"];
    const staleDir = path.join(botVolumeRoot, "bot1", "workspace", "stale-project");
    
    fsMocks.readdir.mockImplementation(async (dirPath: string) => {
      if (dirPath === botVolumeRoot) {
        return ["bot1"];
      } else if (dirPath === path.join(botVolumeRoot, "bot1")) {
        return ["workspace"];
      } else if (dirPath === path.join(botVolumeRoot, "bot1", "workspace")) {
        return ["stale-project"];
      }
      return [];
    });
    
    // Mock stats: no .heartbeat markers (not alive), directories are old
    // enough to be deleted.
    const oldTime = new Date(Date.now() - 2000); // 2 seconds ago
    const dirStats = {
      isDirectory: () => true,
      isFile: () => false,
      mtime: oldTime,
      size: 0,
      blksize: 0,
      blocks: 0,
      atime: oldTime,
      birthtime: oldTime,
      ctime: oldTime,
      dev: 0,
      gid: 0,
      ino: 0,
      mode: 0,
      nlink: 0,
      rdev: 0,
      uid: 0,
    } as Stats;
    fsMocks.stat.mockImplementation(async (p: string) => {
      if (p.endsWith(".heartbeat")) {
        throw new Error("ENOENT: no heartbeat marker");
      }
      return dirStats;
    });
    
    const mockRm = fsMocks.rm.mockResolvedValue(undefined);
    
    await sweepBotVolume(botVolumeRoot, config);
    
    // Verify that rm was called for the stale directory
    expect(mockRm).toHaveBeenCalledWith(staleDir, { recursive: true, force: true });
  });

  it("should not remove directories that are not cleanup candidates", async () => {
    const botVolumeRoot = "/tmp/test-bots";
    const config = {
      enabled: true,
      idleTtlMs: 1000,
      defaultIdleTtlMs: 1000,
    };
    
    // Mock a hermes directory which should NOT be cleaned up
    const hermesDir = path.join(botVolumeRoot, "bot1", "hermes");
    
    fsMocks.readdir.mockResolvedValue(["bot1"]);
    fsMocks.stat.mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(Date.now() - 2000),
      isFile: () => false,
      size: 0,
      blksize: 0,
      blocks: 0,
      atime: new Date(Date.now() - 2000),
      birthtime: new Date(Date.now() - 2000),
      ctime: new Date(Date.now() - 2000),
      dev: 0,
      gid: 0,
      ino: 0,
      mode: 0,
      nlink: 0,
      rdev: 0,
      uid: 0,
    } as Stats);
    
    const mockRm = fsMocks.rm.mockResolvedValue(undefined);
    
    await sweepBotVolume(botVolumeRoot, config);
    
    // The hermes directory should not be removed
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("should not remove directories with active runs", async () => {
    const botVolumeRoot = "/tmp/test-bots";
    const config = {
      enabled: true,
      idleTtlMs: 1000,
      defaultIdleTtlMs: 1000,
    };
    
    const activeDir = path.join(botVolumeRoot, "bot1", "workspace", "active-project");
    
    fsMocks.readdir.mockResolvedValue(["bot1"]);
    fsMocks.stat.mockImplementation(async (path: string) => {
      if (path.endsWith(".heartbeat")) {
        // Simulate that the heartbeat marker exists (active run)
        return {
          isDirectory: () => false,
          isFile: () => true,
          mtime: new Date(),
          size: 0,
          blksize: 0,
          blocks: 0,
          atime: new Date(),
          birthtime: new Date(),
          ctime: new Date(),
          dev: 0,
          gid: 0,
          ino: 0,
          mode: 0,
          nlink: 0,
          rdev: 0,
          uid: 0,
        } as Stats;
      }
      
      return {
        isDirectory: () => true,
        mtime: new Date(Date.now() - 2000),
        isFile: () => false,
        size: 0,
        blksize: 0,
        blocks: 0,
        atime: new Date(Date.now() - 2000),
        birthtime: new Date(Date.now() - 2000),
        ctime: new Date(Date.now() - 2000),
        dev: 0,
        gid: 0,
        ino: 0,
        mode: 0,
        nlink: 0,
        rdev: 0,
        uid: 0,
      } as Stats;
    });
    
    const mockRm = fsMocks.rm.mockResolvedValue(undefined);
    
    await sweepBotVolume(botVolumeRoot, config);
    
    // Directories with active runs should not be removed
    expect(mockRm).not.toHaveBeenCalled();
  });
});