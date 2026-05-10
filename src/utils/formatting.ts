import dayjs from './dayjs.js';

/** Parse seconds into hours, minutes, seconds components using dayjs. */
export function parseDuration(seconds: number): { hrs: number; mins: number; secs: number } {
  const dur = dayjs.duration(seconds, 'seconds');
  return {
    hrs: dur.hours(),
    mins: dur.minutes(),
    secs: dur.seconds(),
  };
}

/** Format seconds as HH:mm:ss string. */
export function toHHMMSS(seconds: number): string {
  return dayjs.duration(seconds, 'seconds').format('HH:mm:ss');
}

/** Parse HH:MM:SS.ms timecode string (e.g. "00:01:21.66") to total seconds using dayjs. */
export function parseTimecode(timecode: string): number {
  const parts = timecode.split(':');
  const hours = parts[0] != null ? parseFloat(parts[0]) : 0;
  const minutes = parts[1] != null ? parseFloat(parts[1]) : 0;
  const seconds = parts[2] != null ? parseFloat(parts[2]) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Parse Twitch duration string (e.g. "1h23m45s") into total seconds. */
export function parseTwitchDuration(durationStr: string): number {
  const str = String(durationStr);
  const hoursMatch = str.match(/(\d+)h/);
  const minsMatch = str.match(/(\d+)m/);
  const secsMatch = str.match(/(\d+(\.\d+)?)s/);

  if (!hoursMatch && !minsMatch && !secsMatch) {
    throw new Error(`Invalid Twitch duration format: ${durationStr}`);
  }

  const hours = hoursMatch?.[1] != null ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minsMatch?.[1] != null ? parseInt(minsMatch[1], 10) : 0;
  const seconds = secsMatch?.[1] != null ? parseFloat(secsMatch[1]) : 0;

  return hours * 3600 + minutes * 60 + Math.floor(seconds);
}

/** Humanize a duration string (e.g. "5 minutes", "2 hours") using dayjs. */
export function humanizeDuration(seconds: number): string {
  return dayjs.duration(seconds, 'seconds').humanize(true);
}

/** Rounds a 0–1 ratio to a percentage with the given decimal places (e.g. 0.956, 1 → 95.6). */
export function toPercentage(ratio: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(ratio * 100 * factor) / factor;
}

/** Extract the database name from a PostgreSQL connection string. */
export function extractDatabaseName(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const dbName = parsed.pathname.slice(1);
    return dbName !== '' ? dbName : 'postgres';
  } catch {
    return 'postgres';
  }
}

/** Format bytes into human-readable string (B, KB, MB, GB). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
