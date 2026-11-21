// Keeps operator files (setup script, docs) from being served as static assets.
export const onRequest = () => new Response("Not found", { status: 404 });
