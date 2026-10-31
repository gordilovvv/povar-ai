import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from '#environment.js';

const genderSchema = z.enum(['male', 'female', 'unknown']);
export type Gender = z.infer<typeof genderSchema>;

export class GenderDetector {
    private static readonly client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    private static readonly FORMAT = zodOutputFormat(z.object({ gender: genderSchema }));
    private static readonly MAX_TOKENS = 16;
    private static readonly SYSTEM =
        'Determine the gender of a person by their name. Unisex or unrecognizable name → unknown.';

    static async detect(name: string): Promise<Gender> {
        const response = await GenderDetector.client.messages.parse({
            model: env.ANTHROPIC_GENDER_MODEL,
            max_tokens: GenderDetector.MAX_TOKENS,
            thinking: { type: 'disabled' },
            output_config: { effort: 'low', format: GenderDetector.FORMAT },
            system: GenderDetector.SYSTEM,
            messages: [{ role: 'user', content: name }],
        });
        if (!response.parsed_output) {
            throw new Error(`[gender] no parsed output for "${name}": ${response.stop_reason}`);
        }
        return response.parsed_output.gender;
    }
}
