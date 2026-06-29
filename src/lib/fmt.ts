import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { DUBAI_TZ } from './time.ts';

dayjs.extend(utc);
dayjs.extend(timezone);

export function capitalize(str: string) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function toDateTime(date: Date | string | number) {
    return dayjs(date).tz(DUBAI_TZ).format('YYYY-MM-DD HH:mm:ss');
}

export function fromDateTime(date: string) {
    return dayjs.tz(date, 'YYYY-MM-DD HH:mm:ss', DUBAI_TZ).toDate();
}
