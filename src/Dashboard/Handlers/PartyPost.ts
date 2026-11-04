import type { IRequest, RequestHandler } from 'itty-router';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import {
    insertParty,
    type PartyStorage,
    partyTypeSchema,
    replacePartyTime,
    updateParty,
} from '#Dashboard/Db/Parties.js';
import { pool, UNIQUE_ERROR_CODE } from '#Dashboard/Db/Pool.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { toDateTime } from '#Lib/Fmt.js';

const isoUtc = z.iso.datetime();
// Postgres отвергает NUL в text — без этой проверки кривой ввод даёт 500, а не 400
const text = z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.includes('\0'));

const bodySchema = z.object({
    id: z.string().regex(/^[a-z0-9_]{1,100}$/),
    type: partyTypeSchema,
    name: text,
    price: z.number().min(0),
    location: text,
    googleMapLink: text.nullable(),
    reelsUrl: text.nullable(),
    notes: text.nullable(),
    time: z
        .object({
            startsAt: isoUtc,
            endsAt: isoUtc,
            freeEntryBefore: isoUtc.optional(),
            guestlistAlertAt: isoUtc,
        })
        .refine((time) => Date.parse(time.endsAt) >= Date.parse(time.startsAt))
        .optional(),
});

export const partyPostHandler: RequestHandler<IRequest> = async (request) => {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return badRequest();
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        return badRequest();
    }
    const body = parsed.data;

    const party: PartyStorage = {
        id: body.id,
        type: body.type,
        name: body.name,
        price: body.price,
        location: body.location,
        google_map_link: body.googleMapLink,
        reels_url: body.reelsUrl,
        notes: body.notes,
    };

    const client = await pool.connect();
    try {
        await client.query('begin; savepoint insert_party');
        try {
            await insertParty(client, party);
        } catch (error) {
            if (!(error instanceof DatabaseError) || error.code !== UNIQUE_ERROR_CODE) {
                throw error;
            }
            await client.query('rollback to savepoint insert_party');
            await updateParty(client, party);
        }
        if (body.time) {
            await replacePartyTime(client, {
                party_id: body.id,
                party_start_at: toDateTime(body.time.startsAt),
                party_end_at: toDateTime(body.time.endsAt),
                free_entry_before: body.time.freeEntryBefore
                    ? toDateTime(body.time.freeEntryBefore)
                    : null,
                guestlist_alert_at: toDateTime(body.time.guestlistAlertAt),
            });
        }
        await client.query('commit');
    } catch (error) {
        await client.query('rollback');
        throw error;
    } finally {
        client.release();
    }

    console.log(`[dashboard:party_post] ${body.id}`);

    return success({ id: body.id });
};
