
export async function onRequestPost(context) {
  const webhookUrl = context.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return new Response(JSON.stringify({ ok: false, error: "Webhook not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await context.request.text();

    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    return new Response(JSON.stringify({ ok: discordRes.ok }), {
      status: discordRes.ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
