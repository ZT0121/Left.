import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

type Card = { id: string; name: string; is_active: boolean | null };
type Candidate = {
  card_id: string | null;
  candidate_key: string;
  candidate_kind: "purchase" | "statement";
  source_type: "email";
  source_count: number;
  source_refs: Array<Record<string, string>>;
  occurred_at: string;
  due_date?: string | null;
  merchant: string;
  amount: number;
  currency: string;
  raw_subject: string;
  raw_excerpt: string;
  matched_transaction_id?: string | null;
};

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function base64UrlDecode(value = "") {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function flattenParts(part: any): any[] {
  return [part, ...(part.parts || []).flatMap(flattenParts)];
}

function messageText(message: any) {
  const parts = flattenParts(message.payload || {});
  const textPart = parts.find((part) => part.mimeType === "text/plain" && part.body?.data)
    || parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  const body = textPart?.body?.data ? base64UrlDecode(textPart.body.data) : message.snippet || "";
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function header(message: any, name: string) {
  return (message.payload?.headers || []).find((item: any) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function compact(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value: string) {
  return compact(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function formatTaipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function parseDate(text: string) {
  const full = text.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const short = text.match(/(?:消費|交易|授權|入帳|日期|時間)[^\d]{0,8}(\d{1,2})[/-](\d{1,2})/);
  if (short) return `${formatTaipeiDate().slice(0, 4)}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  return formatTaipeiDate();
}

function isNonPurchaseMessage(text: string) {
  return [
    /發票|統一發票|載具|中獎/,
    /同意書|同意願|詢問意願|滿意度|問卷/,
    /驗證碼|登入|密碼|安全性/,
    /繳款|扣繳|轉帳|入帳通知/
  ].some((pattern) => pattern.test(text));
}

function isStatementMessage(text: string) {
  return /信用卡.*(?:電子)?帳單|(?:電子)?帳單.*信用卡|對帳單/.test(text);
}

function hasPurchaseSignal(text: string) {
  return [
    /刷卡(?:消費)?(?:成功|通知)?/,
    /消費(?:成功|通知|金額)/,
    /交易(?:成功|通知|金額)/,
    /授權(?:成功|通知|金額)/,
    /特店|商店|商家|店家|merchant/i
  ].some((pattern) => pattern.test(text));
}

function parseDueDate(text: string) {
  const labeled = text.match(/(?:繳款日|繳費日|繳款截止日|應繳日期|付款截止日)[^\d]{0,12}(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
  if (labeled) return `${labeled[1]}-${labeled[2].padStart(2, "0")}-${labeled[3].padStart(2, "0")}`;
  return null;
}

function parseAmount(text: string) {
  const patterns = [
    /(?:NT\$|TWD|新臺幣|新台幣|金額|消費金額|交易金額|授權金額)[^\d]{0,12}([\d,]+)(?:\.\d+)?/i,
    /\$[\s]*([\d,]+)(?:\.\d+)?/
  ];
  for (const pattern of patterns) {
    const amount = Number((text.match(pattern)?.[1] || "").replace(/,/g, ""));
    if (amount > 0 && amount < 10000000) return amount;
  }
  return 0;
}

function parseMerchant(text: string, subject: string) {
  const lines = `${subject}\n${text}`.split(/\r?\n|。|；|;/).map((line) => line.trim()).filter(Boolean);
  const patterns = [
    /(?:商店|商家|特店|店家|消費店家|交易店家|merchant)[：:\s]+(.+)/i,
    /(?:於|在)\s*([^，,。\n]{2,40})\s*(?:消費|交易|刷卡)/
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const value = compact(line.match(pattern)?.[1] || "").replace(/[，,].*$/, "");
      if (value && !/\d{4,}/.test(value)) return value.slice(0, 80);
    }
  }
  return compact(subject || "未命名消費").slice(0, 80);
}

function inferCardId(text: string, cards: Card[]) {
  const activeCards = cards.filter((card) => card.is_active !== false);
  const matched = activeCards.find((card) => normalize(text).includes(normalize(card.name)));
  if (matched) return matched.id;
  return activeCards.length === 1 ? activeCards[0].id : null;
}

function candidateKey(candidate: Omit<Candidate, "candidate_key">) {
  return [
    candidate.candidate_kind,
    candidate.card_id || "no-card",
    candidate.occurred_at,
    candidate.amount,
    normalize(candidate.merchant).slice(0, 24)
  ].join(":");
}

function gmailIdsFromSourceRefs(sourceRefs: unknown) {
  if (!Array.isArray(sourceRefs)) return [];
  return sourceRefs
    .map((ref: any) => String(ref?.gmail_id || ""))
    .filter(Boolean);
}

function buildCandidate(message: any, cards: Card[]): Candidate | null {
  const subject = header(message, "subject");
  const from = header(message, "from");
  const text = messageText(message);
  const combined = `${subject}\n${from}\n${text}`;
  const candidateKind = isStatementMessage(combined) ? "statement" : "purchase";
  if (candidateKind === "purchase" && isNonPurchaseMessage(combined)) {
    console.log("gmail candidate skipped: non_purchase", { subject, from });
    return null;
  }
  if (candidateKind === "purchase" && !hasPurchaseSignal(combined)) {
    console.log("gmail candidate skipped: weak_purchase_signal", { subject, from });
    return null;
  }
  const amount = parseAmount(combined);
  if (!amount) {
    console.log("gmail candidate skipped: no_labeled_amount", { subject, from });
    return null;
  }
  const base = {
    card_id: inferCardId(combined, cards),
    candidate_kind: candidateKind,
    source_type: "email" as const,
    source_count: 1,
    source_refs: [{ gmail_id: message.id, thread_id: message.threadId, subject }],
    occurred_at: parseDate(combined),
    due_date: candidateKind === "statement" ? parseDueDate(combined) : null,
    merchant: parseMerchant(text, subject),
    amount,
    currency: "TWD",
    raw_subject: subject.slice(0, 160),
    raw_excerpt: text.slice(0, 700)
  };
  return { ...base, candidate_key: candidateKey(base) };
}

async function getAuthenticatedUser(req: Request) {
  const supabaseUrl = env("SUPABASE_URL");
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) throw new Error("unauthorized");
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      "authorization": auth,
      "apikey": env("SUPABASE_ANON_KEY")
    }
  });
  if (!response.ok) throw new Error("unauthorized");
  return await response.json();
}

async function exchangeRefreshToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!response.ok) throw new Error(`google_refresh_failed:${await response.text()}`);
  return await response.json();
}

async function gmailFetch(path: string, accessToken: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`gmail_api_failed:${await response.text()}`);
  return await response.json();
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gmailFetchWithRetry(path: string, accessToken: string, attempts = 3) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await gmailFetch(path, accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("rateLimitExceeded") || index === attempts - 1) throw error;
      await wait(800 * (index + 1));
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: jsonHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const url = new URL(req.url);
    const redirectUri = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/gmail-sync/callback`;

    if (url.pathname.endsWith("/callback")) {
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const stateResult = await admin.from("gmail_oauth_states").select("*").eq("state", state).single();
      if (stateResult.error || !stateResult.data) throw new Error("invalid_oauth_state");

      const body = new URLSearchParams({
        code,
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      });
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
      if (!tokenResponse.ok) throw new Error(`google_token_failed:${await tokenResponse.text()}`);
      const tokens = await tokenResponse.json();
      if (!tokens.refresh_token) throw new Error("missing_refresh_token");

      const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = profileResponse.ok ? await profileResponse.json() : {};
      await admin.from("gmail_connections").upsert({
        user_id: stateResult.data.user_id,
        gmail_email: profile.emailAddress || null,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope || GMAIL_SCOPE,
        connected_at: new Date().toISOString()
      });
      await admin.from("gmail_oauth_states").delete().eq("state", state);
      return Response.redirect(stateResult.data.redirect_to, 302);
    }

    const user = await getAuthenticatedUser(req);
    if (url.pathname.endsWith("/start")) {
      const state = crypto.randomUUID();
      const body = await req.json().catch(() => ({}));
      await admin.from("gmail_oauth_states").insert({
        state,
        user_id: user.id,
        redirect_to: body.redirect_to || body.redirectTo || "/"
      });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", GMAIL_SCOPE);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);
      return new Response(JSON.stringify({ auth_url: authUrl.href }), { headers: jsonHeaders });
    }

    if (url.pathname.endsWith("/status")) {
      const result = await admin.from("gmail_connections").select("gmail_email, last_sync_at").eq("user_id", user.id).maybeSingle();
      return new Response(JSON.stringify({ connected: Boolean(result.data), connection: result.data || null }), { headers: jsonHeaders });
    }

    if (url.pathname.endsWith("/sync")) {
      const syncBody = await req.json().catch(() => ({}));
      const connection = await admin.from("gmail_connections").select("*").eq("user_id", user.id).single();
      if (connection.error || !connection.data) throw new Error("gmail_not_connected");
      const token = await exchangeRefreshToken(connection.data.refresh_token);

      const [cycleResult, cardResult] = await Promise.all([
        admin.from("budget_cycles").select("*").eq("user_id", user.id).eq("is_closed", false).order("start_date", { ascending: false }).limit(1).single(),
        admin.from("credit_cards").select("id, name, is_active").eq("user_id", user.id)
      ]);
      if (cycleResult.error || !cycleResult.data) throw new Error("active_cycle_not_found");
      if (cardResult.error) throw cardResult.error;

      const query = encodeURIComponent('newer_than:30d ("刷卡成功" OR "刷卡消費" OR "消費通知" OR "授權成功" OR "交易成功" OR "信用卡電子帳單" OR "信用卡帳單") -發票 -統一發票 -載具 -同意 -問卷 -in:spam -in:trash');
      const list = await gmailFetchWithRetry(`messages?q=${query}&maxResults=20`, token.access_token);
      const messages = [];
      for (const item of list.messages || []) {
        messages.push(await gmailFetchWithRetry(`messages/${item.id}?format=full`, token.access_token));
        await wait(150);
      }

      let reset = 0;
      if (syncBody.reset_pending || syncBody.resetPending) {
        const resetResult = await admin
          .from("email_transaction_candidates")
          .delete()
          .eq("user_id", user.id)
          .eq("cycle_id", cycleResult.data.id)
          .in("status", ["pending", "duplicate"])
          .select("id");
        if (resetResult.error) throw resetResult.error;
        reset = resetResult.data?.length || 0;
      }

      const existingCandidateRefs = await admin
        .from("email_transaction_candidates")
        .select("source_refs")
        .eq("user_id", user.id);
      if (existingCandidateRefs.error) throw existingCandidateRefs.error;
      const rememberedGmailIds = new Set(
        (existingCandidateRefs.data || []).flatMap((row: any) => gmailIdsFromSourceRefs(row.source_refs))
      );
      let remembered = 0;
      const newMessages = messages.filter((message: any) => {
        if (!rememberedGmailIds.has(message.id)) return true;
        remembered += 1;
        return false;
      });

      const candidates = newMessages
        .map((message) => buildCandidate(message, cardResult.data || []))
        .filter(Boolean) as Candidate[];

      let imported = 0;
      let merged = 0;
      let failed = 0;
      const failures: string[] = [];
      for (const candidate of candidates) {
        const existing = await admin
          .from("email_transaction_candidates")
          .select("id, source_count, source_refs")
          .eq("user_id", user.id)
          .eq("candidate_key", candidate.candidate_key)
          .maybeSingle();

        if (existing.data) {
          const refs = Array.isArray(existing.data.source_refs) ? existing.data.source_refs : [];
          const ids = new Set(refs.map((ref: any) => ref.gmail_id));
          const nextRefs = ids.has(candidate.source_refs[0].gmail_id) ? refs : [...refs, ...candidate.source_refs];
          const updateResult = await admin.from("email_transaction_candidates").update({
            source_count: nextRefs.length,
            source_refs: nextRefs,
            raw_excerpt: candidate.raw_excerpt
          }).eq("id", existing.data.id);
          if (updateResult.error) {
            failed += 1;
            failures.push(`${candidate.raw_subject}: ${updateResult.error.message}`);
            continue;
          }
          if (candidate.source_refs[0].gmail_id) rememberedGmailIds.add(candidate.source_refs[0].gmail_id);
          merged += 1;
        } else {
          const insertResult = await admin.from("email_transaction_candidates").insert({
            user_id: user.id,
            cycle_id: cycleResult.data.id,
            ...candidate
          });
          if (insertResult.error) {
            failed += 1;
            failures.push(`${candidate.raw_subject}: ${insertResult.error.message}`);
            continue;
          }
          if (candidate.source_refs[0].gmail_id) rememberedGmailIds.add(candidate.source_refs[0].gmail_id);
          imported += 1;
        }
      }

      await admin.from("gmail_connections").update({ last_sync_at: new Date().toISOString() }).eq("user_id", user.id);
      return new Response(JSON.stringify({ scanned: messages.length, reset, remembered, parsed: candidates.length, imported, merged, failed, failures: failures.slice(0, 5) }), { headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "unauthorized" ? 401 : 400;
    return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders });
  }
});
