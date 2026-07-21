import type Anthropic from '@anthropic-ai/sdk';
import { Prompts } from '#Intelligence/Prompts.js';

/** Факты хода для хвостового блока: что известно, что сделано, что делаем сейчас. */
export interface FlowState {
    state: string[];
    done: string[];
    now: string;
    lang: 'ru' | 'en';
    /** Dubai-время хода, 24h. */
    nowTime: string;
}

export class Checklist {
    private static readonly LANG = {
        en: 'The guest writes in ENGLISH — reply ONLY in English.',
        ru: 'The guest writes in RUSSIAN — reply in Russian.',
    };

    /**
     * System для одного хода: кешируемый промт + хвост, собранный заново из фактов.
     */
    static buildSystem(flow: FlowState): Anthropic.TextBlockParam[] {
        const tail = [
            Prompts.checklist,
            Prompts.tools,
            `Language: ${Checklist.LANG[flow.lang]}`,
            `Dubai time now: ${flow.nowTime}.`,
            Checklist.buildStateBlock(flow),
        ].join('\n\n');

        return [
            { type: 'text', text: Prompts.system, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: tail },
        ];
    }

    static buildStateBlock(flow: FlowState): string {
        return [
            `State: ${flow.state.length ? flow.state.join('; ') : 'nothing known yet'}`,
            `Done: ${flow.done.length ? flow.done.join('; ') : 'nothing yet'}`,
            `Now: ${flow.now}`,
        ].join('\n');
    }
}
