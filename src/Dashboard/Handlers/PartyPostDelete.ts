import type { IRequest, RequestHandler } from 'itty-router';
import { DatabaseError } from 'pg';
import { deleteParty } from '#Dashboard/Db/Parties.js';
import { FOREIGN_KEY_ERROR_CODE, pool } from '#Dashboard/Db/Pool.js';
import { badRequest, conflict, notFound, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';

export const partyPostDeleteHandler: RequestHandler<IRequest> = async (request) => {
    const partyId = safeParseString(request.params.id);
    if (partyId === null) {
        return badRequest();
    }

    const client = await pool.connect();
    try {
        const deletedCount = await deleteParty(client, partyId);
        if (!deletedCount) {
            return notFound();
        }
    } catch (error) {
        // FK от party_guestlist: в гест-листе есть гости, statement откатился целиком
        if (error instanceof DatabaseError && error.code === FOREIGN_KEY_ERROR_CODE) {
            return conflict();
        }
        throw error;
    } finally {
        client.release();
    }

    console.log(`[dashboard:party_delete] ${partyId}`);

    return success({ id: partyId });
};
