import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const DUBAI_TZ = 'Asia/Dubai';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const weekday = (d: dayjs.Dayjs) => WEEKDAYS[d.day()];

export const getDubaiTime = () => dayjs().tz(DUBAI_TZ);

export const formatDubai = (date: Date | string) => {
    const d = dayjs(date).tz(DUBAI_TZ);
    return `${weekday(d)} ${d.format('DD.MM HH:mm')}`;
};

export const formatDubaiNow = () => {
    const d = getDubaiTime();
    return `${weekday(d)} ${d.format('YYYY-MM-DD HH:mm:ss')}`;
};
