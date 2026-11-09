// Every invite link gets the same page, which reads the code from the
// address. Served at /join/<code> itself rather than redirected, so the
// address the page reads is still the one that was shared.
type Context = { request: Request; env: { ASSETS: { fetch: (url: URL) => Promise<Response> } } };

export const onRequestGet = ({ request, env }: Context): Promise<Response> =>
  env.ASSETS.fetch(new URL("/join/", request.url));
