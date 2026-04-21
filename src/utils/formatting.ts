import dayjs from './dayjs.js';

export function parseDuration(seconds: number): { hrs: number; mins: number; secs: number } {
  const dur = dayjs.duration(seconds, 'seconds');
  return {
    hrs: dur.hours(),
    mins: dur.minutes(),
    secs: dur.seconds(),
  };
}

export function toHHMMSS(seconds: number): string {
  return dayjs.duration(seconds, 'seconds').format('HH:mm:ss');
}

export function parseTwitchDuration(durationStr: string): number {
  const str = String(durationStr);
  const hoursMatch = str.match(/(\d+)h/);
  const minsMatch = str.match(/(\d+)m/);
  const secsMatch = str.match(/(\d+(\.\d+)?)s/);

  if (!hoursMatch && !minsMatch && !secsMatch) {
    throw new Error(`Invalid Twitch duration format: ${durationStr}`);
  }

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minsMatch ? parseInt(minsMatch[1], 10) : 0;
  const seconds = secsMatch ? parseFloat(secsMatch[1]) : 0;

  return hours * 3600 + minutes * 60 + Math.floor(seconds);
}

export function humanizeDuration(seconds: number): string {
  return dayjs.duration(seconds, 'seconds').humanize(true);
}

export function extractDatabaseName(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const dbName = parsed.pathname.slice(1);
    return dbName || 'postgres';
  } catch {
    return 'postgres';
  }
}
