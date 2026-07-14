export type Lang = 'ru' | 'en';

const MIN_LETTERS = 3;
const RECENCY_DECAY = 0.7;
const NOISE = /https?:\/\/\S+|\S+@\S+\.\S+|@[\w.]+/g;

export const parseLanguage = (messages: string[]): Lang | null => {
    let ru = 0;
    let en = 0;
    let weight = 1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const text = messages[i]?.replace(NOISE, '');
        if (!text) {
            continue;
        }
        const cyrillic = (text.match(/[а-яё]/gi) ?? []).length;
        const latin = (text.match(/[a-z]/gi) ?? []).length;
        if (cyrillic + latin < MIN_LETTERS) {
            continue;
        }
        if (cyrillic > 0) {
            ru += weight;
        } else {
            en += weight;
        }
        weight *= RECENCY_DECAY;
    }
    if (!ru && !en) {
        return null;
    }
    return en > ru ? 'en' : 'ru';
};
