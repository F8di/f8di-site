// Keeps function source from being served as static assets.
export const onRequest = () => new Response("Not found", { status: 404 });
