import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

type Reminder = {
  user_id: string;
  key: string;
  title: string;
  body: string;
  url: string;
  tag: string;
};

const jsonHeaders = { "content-type": "application/json" };

function taipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function daysUntil(dateValue: string, todayValue: string) {
  const target = Date.parse(`${dateValue}T00:00:00Z`);
  const today = Date.parse(`${todayValue}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: jsonHeaders
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "missing_supabase_environment" }), {
      status: 500,
      headers: jsonHeaders
    });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const configResult = await client
    .from("push_config")
    .select("vapid_public_key, vapid_private_key, cron_secret")
    .eq("singleton", true)
    .single();

  if (configResult.error || !configResult.data) {
    console.error("push config unavailable", configResult.error);
    return new Response(JSON.stringify({ error: "push_config_unavailable" }), {
      status: 500,
      headers: jsonHeaders
    });
  }
  if (req.headers.get("x-cron-secret") !== configResult.data.cron_secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: jsonHeaders
    });
  }

  webpush.setVapidDetails(
    "https://zt0121.github.io/Left./",
    configResult.data.vapid_public_key,
    configResult.data.vapid_private_key
  );

  const [chargeResult, reimbursementResult, subscriptionResult, deliveryResult] = await Promise.all([
    client
      .from("credit_card_charges")
      .select("id, user_id, title, amount, due_date")
      .eq("source_type", "opening_bill")
      .eq("status", "pending")
      .not("due_date", "is", null),
    client
      .from("reimbursements")
      .select("id, user_id, title, amount, created_at")
      .eq("status", "pending"),
    client
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth"),
    client
      .from("notification_deliveries")
      .select("subscription_id, reminder_key")
  ]);

  for (const result of [chargeResult, reimbursementResult, subscriptionResult, deliveryResult]) {
    if (result.error) {
      console.error("notification query failed", result.error);
      return new Response(JSON.stringify({ error: "notification_query_failed" }), {
        status: 500,
        headers: jsonHeaders
      });
    }
  }

  const today = taipeiDate();
  const reminders: Reminder[] = [];
  for (const row of chargeResult.data || []) {
    const days = daysUntil(row.due_date, today);
    if (days !== 3 && days !== 0) continue;
    reminders.push({
      user_id: row.user_id,
      key: `card:${row.id}:${days === 3 ? "due-in-3-days" : "due-today"}`,
      title: days === 3 ? "卡費 3 天後到期" : "卡費今天到期",
      body: `${row.title || "信用卡帳單"} ${new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(Number(row.amount || 0))} 尚未繳款`,
      url: "./index.html?reminder=card",
      tag: `card-${row.id}-${days}`
    });
  }

  const now = Date.now();
  for (const row of reimbursementResult.data || []) {
    if (now - Date.parse(row.created_at) <= 86400000) continue;
    reminders.push({
      user_id: row.user_id,
      key: `reimbursement:${row.id}:over-1-day`,
      title: "待收款已超過 1 天",
      body: `${row.title || "待收款"} ${new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(Number(row.amount || 0))} 尚未收回`,
      url: "./index.html?reminder=reimbursement",
      tag: `reimbursement-${row.id}`
    });
  }

  const sent = new Set(
    (deliveryResult.data || []).map((row) => `${row.subscription_id}:${row.reminder_key}`)
  );
  let delivered = 0;
  let removed = 0;
  const failures: string[] = [];

  for (const subscription of subscriptionResult.data || []) {
    const userReminders = reminders.filter((reminder) => reminder.user_id === subscription.user_id);
    for (const reminder of userReminders) {
      const deliveryKey = `${subscription.id}:${reminder.key}`;
      if (sent.has(deliveryKey)) continue;
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
          }
        }, JSON.stringify({
          title: reminder.title,
          body: reminder.body,
          url: reminder.url,
          tag: reminder.tag,
          icon: "./assets/branding/left-icon-192.png",
          badge: "./assets/branding/left-favicon-64.png"
        }));
        const deliveryInsert = await client.from("notification_deliveries").insert({
          user_id: reminder.user_id,
          subscription_id: subscription.id,
          reminder_key: reminder.key
        });
        if (deliveryInsert.error && deliveryInsert.error.code !== "23505") {
          throw deliveryInsert.error;
        }
        delivered += 1;
      } catch (error) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          await client.from("push_subscriptions").delete().eq("id", subscription.id);
          removed += 1;
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${subscription.id}:${reminder.key}:${message}`);
        console.error("push delivery failed", { subscriptionId: subscription.id, reminderKey: reminder.key, error });
      }
    }
  }

  return new Response(JSON.stringify({
    date: today,
    reminders: reminders.length,
    delivered,
    removed,
    failures
  }), { headers: jsonHeaders });
});
