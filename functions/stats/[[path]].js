// Unreachable: functions/stats/_middleware.js answers every /stats request.
export const onRequest = () => new Response("Not found", { status: 404 });
