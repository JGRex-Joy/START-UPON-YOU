const MJD_UNIX_EPOCH = 40587;

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000);
}

export function mjdToIso(mjd: number): string {
  return mjdToDate(mjd).toISOString();
}

/** "2025-07-16" */
export function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

export function decimalYear(date: Date): number {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (end - start);
}

export function formatDuration(days: number): string {
  if (days < 2) return `${(days * 24).toFixed(0)} h`;
  if (days < 90) return `${days.toFixed(0)} d`;
  return `${(days / 30.4375).toFixed(1)} mo`;
}
