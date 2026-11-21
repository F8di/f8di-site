import { handleStats } from "../_lib/app.js";

export const onRequest = (ctx) => handleStats(ctx);
