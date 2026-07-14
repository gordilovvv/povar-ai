import addToGuestlist from '#Intelligence/Tools/AddToGuestlist.js';
import bookTable from '#Intelligence/Tools/BookTable.js';
import getParties from '#Intelligence/Tools/GetParties.js';
import sendMessage from '#Intelligence/Tools/SendMessage.js';
import showTables from '#Intelligence/Tools/ShowTables.js';
import type { AgentTool } from '#Intelligence/Tools/Types.js';
import updateGuest from '#Intelligence/Tools/UpdateGuest.js';

export const tools: AgentTool[] = [
    sendMessage,
    getParties,
    updateGuest,
    addToGuestlist,
    bookTable,
    showTables,
];

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
