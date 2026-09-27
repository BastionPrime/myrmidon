/**
 * Missed backup slot threshold (P11).
 *
 * Each scheduled tick replaces the newest dump, so on a healthy cadence the age
 * of the newest dump peaks just under the interval. The vendor stale warning
 * starts at max(26h, 2x interval) and cannot see a single missed slot. Past this
 * threshold `/api/health` reports `database_backup_slot_missed`.
 */
export function resolveBackupSlotGapThresholdHours(intervalMinutes: number): number {
  const intervalHours = intervalMinutes / 60;
  return Math.round(Math.max(intervalHours * 1.5, intervalHours + 2) * 10) / 10;
}
