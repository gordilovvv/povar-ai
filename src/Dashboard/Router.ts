import { IttyRouter, status } from 'itty-router';
import { withAuthorization } from '#Dashboard/Authorization.js';
import { chatsGetListHandler } from '#Dashboard/Handlers/ChatsGetList.js';
import { serverError } from '#Dashboard/Lib/Response.js';

const router = IttyRouter();
router.get('/chats', withAuthorization, chatsGetListHandler);
router.all('*', () => status(404));

export const dashboardFetch = (request: Request) =>
    router.fetch(request).catch((error) => {
        console.error(error);
        return serverError();
    });
