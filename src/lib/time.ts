import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const DUBAI_TZ = 'Asia/Dubai';

export const getDubaiTime = () => dayjs().tz(DUBAI_TZ);
