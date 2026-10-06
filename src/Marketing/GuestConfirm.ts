import type { PoolClient } from 'pg';
import { type GuestConfirmAnswer, updateGuestlistGuestConfirmAnswer } from '#Db/Guestlist.js';
import { selectGuestByPhone } from '#Db/Guests.js';
import { selectPartyHasUpcomingStart } from '#Db/Party.js';
import { Logger } from '#Lib/Logger.js';

export interface GuestConfirmPayload {
    partyId: string;
    answer: Extract<GuestConfirmAnswer, 'yes' | 'no'>;
}

/** Ответ гостя на перекличку (шаблон event_rsvp_confirmation, рассылает Jobs/GuestConfirmEntry). */
export class GuestConfirm {
    private static readonly PAYLOAD = /^guest_confirm:(yes|no):(.+)$/;
    private static readonly REPLY = {
        yes: 'Great, see you at the party! 🎉',
        no: 'Got it, sorry to hear that! Thanks for letting us know.',
    };
    private static readonly PAST_PARTY_REPLY =
        "This party has already happened, so there's nothing to confirm. I'll message you as soon as the next one is coming up! 🎉";

    static parsePayload(payload: string): GuestConfirmPayload | null {
        const match = GuestConfirm.PAYLOAD.exec(payload);
        if (!match?.[2]) {
            return null;
        }
        return { partyId: match[2], answer: match[1] === 'yes' ? 'yes' : 'no' };
    }

    static async answer(
        client: PoolClient,
        phone: string,
        { partyId, answer }: GuestConfirmPayload,
    ): Promise<string | null> {
        const guest = await selectGuestByPhone(client, phone);
        const entry = guest
            ? await updateGuestlistGuestConfirmAnswer(client, partyId, guest.id, answer)
            : null;
        if (!entry) {
            Logger.log(
                `[guest-confirm] ${phone} answered ${answer} for ${partyId} without guest confirm`,
            );
            return null;
        }
        // Вечеринка уже прошла
        if (!(await selectPartyHasUpcomingStart(client, partyId))) {
            Logger.log(`[guest-confirm] ${phone} ${partyId} answered ${answer} after party ended`);
            return GuestConfirm.PAST_PARTY_REPLY;
        }
        Logger.log(`[guest-confirm] ${phone} ${partyId} answered ${answer}`);
        return GuestConfirm.REPLY[answer];
    }
}
