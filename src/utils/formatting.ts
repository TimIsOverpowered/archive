/**
 * Converts seconds to hours, minutes, and seconds components.
 */
function parseDuration(seconds: number): { hrs: number; mins: number; secs: number } {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return { hrs, mins, secs };
}

export function formatDuration(seconds: number): string {
  const { hrs, mins, secs } = parseDuration(seconds);

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m ${secs}s`;
}

export function toHHMMSS(seconds: number): string {
  const { hrs, mins, secs } = parseDuration(seconds);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
