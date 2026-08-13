import { IttyRouter, status } from 'itty-router';
import { withAuthorization } from '#Dashboard/Authorization.js';
import { authLoginHandler } from '#Dashboard/Handlers/AuthLogin.js';
import { authRefreshHandler } from '#Dashboard/Handlers/AuthRefresh.js';
import { chatGetHandler } from '#Dashboard/Handlers/ChatGet.js';
import { chatGetMessagesHandler } from '#Dashboard/Handlers/ChatGetMessages.js';
import { chatSendMessageHandler } from '#Dashboard/Handlers/ChatSendMessage.js';
import { chatSendPhotoHandler } from '#Dashboard/Handlers/ChatSendPhoto.js';
import { chatSetPauseHandler } from '#Dashboard/Handlers/ChatSetPause.js';
import { chatsGetListHandler } from '#Dashboard/Handlers/ChatsGetList.js';
import { mediaGetHandler } from '#Dashboard/Handlers/MediaGet.js';
import { partiesGetListHandler } from '#Dashboard/Handlers/PartiesGetList.js';
import { partyGetGuestlistListHandler } from '#Dashboard/Handlers/PartyGetGuestlist.js';
import { serverError } from '#Dashboard/Lib/Response.js';

const router = IttyRouter();
router.post('/auth/login', authLoginHandler);
router.post('/auth/refresh', authRefreshHandler);
router.get('/chats', withAuthorization, chatsGetListHandler);
router.get('/chats/:phone/messages', withAuthorization, chatGetMessagesHandler);
router.post('/chats/:phone/messages', withAuthorization, chatSendMessageHandler);
router.post('/chats/:phone/photo', withAuthorization, chatSendPhotoHandler);
router.put('/chats/:phone/pause', withAuthorization, chatSetPauseHandler);
router.get('/chats/:phone', withAuthorization, chatGetHandler);
router.get('/parties', withAuthorization, partiesGetListHandler);
router.get('/parties/:id/guestlist', withAuthorization, partyGetGuestlistListHandler);
router.get('/media/:id', withAuthorization, mediaGetHandler);
router.all('*', () => status(404));

export const dashboardFetch = (request: Request) =>
    router.fetch(request).catch((error) => {
        console.error(error);
        return serverError();
    });
