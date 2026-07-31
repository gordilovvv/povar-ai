import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { Lang } from '#Lib/Lang.js';

dayjs.extend(utc);
dayjs.extend(timezone);

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

export const formatDubaiNow = () => {
    const d = getDubaiTime();
    return `${weekday(d, 'en')} ${d.format('YYYY-MM-DD HH:mm:ss')}`;
};
