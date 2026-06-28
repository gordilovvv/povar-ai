import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

export function capitalize(str: string) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function toDateTime(date: Date | string | number) {
    return dayjs(date).utc().format('YYYY-MM-DD HH:mm:ss');
}

export function fromDateTime(date: string) {
    return dayjs.utc(date, 'YYYY-MM-DD HH:mm:ss').toDate();
}
