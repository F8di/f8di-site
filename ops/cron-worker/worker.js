// Standalone Cloudflare Worker that triggers /stats collection on a reliable schedule.
// GitHub's scheduled workflows are heavily delayed on low-traffic repos; this replaces them.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

async function run(env) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${env.STATS_SITE_URL}/stats/api/cron`, { method: "POST", headers: { Authorization: `Bearer ${env.STATS_CRON_TOKEN}` } });
    if (!res.ok) throw new Error(`cron -> HTTP ${res.status}`);
    const { remaining } = await res.json();
    if (!remaining) return;
  }
}
