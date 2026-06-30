import addToGuestlist from './addToGuestlist.ts';
import bookTable from './bookTable.ts';
import getParties from './getParties.ts';
import sendMessage from './sendMessage.ts';
import type { AgentTool } from './types.ts';
import updateGuest from './updateGuest.ts';

export const tools: AgentTool[] = [sendMessage, getParties, updateGuest, addToGuestlist, bookTable];

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
