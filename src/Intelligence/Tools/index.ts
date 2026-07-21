import getParty from '#Intelligence/Tools/GetParty.js';
import pauseChat from '#Intelligence/Tools/PauseChat.js';
import saveGuest from '#Intelligence/Tools/SaveGuest.js';
import sendMessage from '#Intelligence/Tools/SendMessage.js';
import type { AgentTool } from '#Lib/Tools.js';

export const tools: AgentTool[] = [sendMessage, getParty, pauseChat, saveGuest];

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
