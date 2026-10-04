import type { HostDiskConsumerEntry, HostDiskUsageSample } from "@paperclipai/shared";

/**
 * In-process state of the host disk sweep (myrmidon BOT-DISK, part E).
 *
 * The sweep keeps a ring of the newest samples per observed path, so the
 * growth rate per hour needs no table: one sample per sweep, a bounded
 * window, and the slope between the oldest and the newest sample of the
 * window. State is deliberately memory-only — after a restart the first hour
 * has no growth number yet, which the signal says plainly rather than
 * inventing one.
 */

export interface HostDiskSweepResult {
  at: string;
  measuredPath: string | null;
  usedPercent: number | null;
  usedBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  overThreshold: boolean;
  thresholdPercent: number | null;
  growthBytesPerHour: number | null;
  consumers: HostDiskConsumerEntry[];
  signalled: boolean;
  error: string | null;
}

export class HostDiskSampleRing {
  private readonly samples: HostDiskUsageSample[] = [];

  constructor(private readonly maxSamples: number) {}

  push(sample: HostDiskUsageSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  list(): HostDiskUsageSample[] {
    return [...this.samples];
  }

  clear(): void {
    this.samples.length = 0;
  }
}
