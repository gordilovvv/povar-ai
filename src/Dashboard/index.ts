import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { env } from '#Dashboard/environment.js';
import { dashboardFetch } from '#Dashboard/Router.js';

createServer(createServerAdapter(dashboardFetch)).listen(Number(env.PORT));
