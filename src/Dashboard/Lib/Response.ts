const NO_STORE_HEADERS = { 'cache-control': 'no-store' };

export const success = (data: unknown) => Response.json(data, { headers: NO_STORE_HEADERS });

export const badRequest = () =>
    Response.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE_HEADERS });

export const unauthorized = () =>
    Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });

export const notFound = () =>
    Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE_HEADERS });

export const serverError = () =>
    Response.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE_HEADERS });
