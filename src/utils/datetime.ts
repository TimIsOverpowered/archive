import dayjs from 'dayjs';

const tzRegex = /Z|[+-]\d{2}:?\d{2}$/;

export function toUtcISO(datetime: string): string {
  if (tzRegex.test(datetime)) {
    return new Date(datetime).toISOString();
  }
  return dayjs.utc(datetime).toISOString();
}

export function toUtcDate(datetime: string): Date {
  return new Date(toUtcISO(datetime));
}
