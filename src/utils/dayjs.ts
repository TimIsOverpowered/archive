import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import timezone from 'dayjs/plugin/timezone.js';
import utcPlugin from 'dayjs/plugin/utc.js';

dayjs.extend(duration);
dayjs.extend(relativeTime);
dayjs.extend(utcPlugin);
dayjs.extend(timezone);

export default dayjs;
