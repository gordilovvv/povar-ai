import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { Lang } from '#Lib/Lang.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

const DUBAI_TZ = 'Asia/Dubai';

const WEEKDAYS: Record<Lang, string[]> = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
};

const weekday = (d: dayjs.Dayjs, lang: Lang) => WEEKDAYS[lang][d.day()];

export const getDubaiTime = () => dayjs().tz(DUBAI_TZ);

export const formatDubai = (date: Date | string, lang: Lang) => {
    const d = dayjs(date).tz(DUBAI_TZ);
    return `${weekday(d, lang)} ${d.format(lang === 'en' ? 'DD.MM h:mma' : 'DD.MM HH:mm')}`;
};

export const isDubaiToday = (date: Date | string) =>
    dayjs(date).tz(DUBAI_TZ).isSame(getDubaiTime(), 'day');

export const dubaiWeeksFromNow = (date: Date | string) =>
    dayjs(date).tz(DUBAI_TZ).startOf('isoWeek').diff(getDubaiTime().startOf('isoWeek'), 'week');

export const dubaiDaysFromNow = (date: Date | string) =>
    dayjs(date).tz(DUBAI_TZ).startOf('day').diff(getDubaiTime().startOf('day'), 'day');

export const formatDubaiStamp = (date: Date | string) => {
    const d = dayjs(date).tz(DUBAI_TZ);
    const days = getDubaiTime().startOf('day').diff(d.startOf('day'), 'day');
    const time = d.format('HH:mm');
    if (days === 0) {
        return `today ${time}`;
    }
    if (days === 1) {
        return `yesterday ${time}`;
    }
    return `${weekday(d, 'en')} ${d.format('DD.MM.YYYY')} ${time}`;
};

export const formatDubaiNow = () => {
    const d = getDubaiTime();
    return `${weekday(d, 'en')} ${d.format('YYYY-MM-DD HH:mm:ss')}`;
};
