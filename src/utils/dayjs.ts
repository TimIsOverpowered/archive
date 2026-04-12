import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utcPlugin);
dayjs.extend(timezone);

export default dayjs;
