// Cloudflare Worker that:
//   1) Proxies the sidebar's task CRUD to Missive's REST API (so the API
//      token is never exposed to the browser), and
//   2) Receives Missive's `new_comment` webhook, parses shortcut syntax in
//      the comment body, and creates the corresponding Missive task.
//
// Routes:
//   GET    /api/users                       -> list org users
//   GET    /api/tasks?assignee=me&status=…  -> list tasks for the calling user
//   POST   /api/tasks                       -> create a task
//   PATCH  /api/tasks/:id                   -> update status / fields
//   POST   /webhook/missive                 -> Missive webhook endpoint
//
// Required env / secrets (set via `wrangler secret put`):
//   MISSIVE_API_TOKEN     - personal API token for the Missive org
//   MISSIVE_TEAM_ID       - default team UUID for tasks created without an
//                           explicit assignee
//   MISSIVE_ORG_ID        - organization UUID; required by Missive whenever
//                           team or assignees is set on a non-subtask
//   SIDEBAR_TOKEN         - shared secret the sidebar passes as
//                           `Authorization: Bearer <token>`. This is the
//                           ACTUAL auth boundary on /api/*; CORS Origin is
//                           defense-in-depth only (Origin headers are
//                           server-side-spoofable).
//   ALLOWED_ORIGIN        - origin that browser fetches to /api/* must come
//                           from, e.g. https://you.github.io. Defense in
//                           depth, not the primary auth.
//   WEBHOOK_SECRET        - the validation secret you set on the Missive Rule
//   ORG_USERS_JSON        - (optional) JSON array of {id,name,email} used to
//                           resolve @mentions in webhook comments. Without it
//                           the worker falls back to GET /v1/users on every
//                           webhook, which is slower.

import { parseShortcut, decorateTitle } from "./parser.js";

const MISSIVE_BASE = "https://public.missiveapp.com/v1";

// --------- HTTP helpers ----------------------------------------------------
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function corsHeaders(origin, allowed) {
  const ok = origin && allowed && origin === allowed;
  return {
    "access-control-allow-origin": ok ? origin : "null",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-missive-user-email, x-missive-user-id",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

async function missiveFetch(env, path, opts = {}) {
  const r = await fetch(MISSIVE_BASE + path, {
    ...opts,
    headers: {
      "authorization": "Bearer " + env.MISSIVE_API_TOKEN,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) {
    throw new Error(`Missive ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

// --------- Webhook signature ----------------------------------------------
async function validateSignature(req, body, secret) {
  const sig = req.headers.get("x-hook-signature");
  if (!sig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  // Missive prefixes the signature with "sha256=".
  const expected = "sha256=" + hex;
  return timingSafeEqual(sig, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------- Route handlers --------------------------------------------------
async function handleListUsers(env, cors) {
  const data = await missiveFetch(env, "/users");
  const users = (data.users || data || []).map(u => ({
    id: u.id, name: u.name, email: u.email,
  }));
  return json({ users }, 200, cors);
}

async function handleListTasks(env, userEmail, params, cors) {
  // Missive's tasks index supports filtering by assignee. We pull a page and
  // also filter client-side as a safety net since query-string grammar varies.
  const data = await missiveFetch(env, "/tasks?limit=200");
  const all = (data.tasks || []).map(normalizeTask);
  const status = params.get("status") || "any";
  const assignee = params.get("assignee");
  let tasks = all;
  if (status === "open") tasks = tasks.filter(t => t.status !== "closed");
  if (assignee === "me" && userEmail) {
    tasks = tasks.filter(t =>
      (t.assignees || []).some(a => (a.email || "").toLowerCase() === userEmail.toLowerCase())
    );
  }
  return json({ tasks }, 200, cors);
}

async function handleCreateTask(env, userEmail, body, cors) {
  const payload = {
    title: body.title || "(untitled)",
    description: body.description || "",
    status: "todo",
  };
  if (body.due_at)            payload.due_at    = body.due_at;
  if (body.assignees?.length) {
    payload.assignees = body.assignees;
    // Missive requires organization when assignees is set on a non-subtask.
    if (env.MISSIVE_ORG_ID) payload.organization = env.MISSIVE_ORG_ID;
  } else {
    payload.team = env.MISSIVE_TEAM_ID;
    // Missive requires organization whenever team is set.
    if (env.MISSIVE_ORG_ID) payload.organization = env.MISSIVE_ORG_ID;
  }
  if (body.conversation_id) {
    payload.subtask = true;
    payload.conversation = body.conversation_id;
    // Subtasks don't take team/organization; they inherit from the convo.
    delete payload.team;
    delete payload.organization;
  }
  const created = await missiveFetch(env, "/tasks", {
    method: "POST",
    body: JSON.stringify({ tasks: payload }),
  });
  const task = created.tasks || created.task || created;
  return json({ task: normalizeTask(task) }, 200, cors);
}

async function handlePatchTask(env, id, body, cors) {
  const payload = {};
  if (body.status) payload.status = body.status;       // todo|in_progress|closed
  if (body.title)  payload.title  = body.title;
  if (body.due_at !== undefined) payload.due_at = body.due_at;
  const r = await missiveFetch(env, "/tasks/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify({ tasks: payload }),
  });
  return json({ task: normalizeTask(r.tasks || r.task || r) }, 200, cors);
}

function normalizeTask(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    status: t.status || "todo",
    due_at: t.due_at || null,
    assignees: (t.assignees || []).map(a => ({ id: a.id, name: a.name, email: a.email })),
    conversation_id: t.conversation?.id || t.conversation_id || null,
    created_at: t.created_at || null,
  };
}

// --------- Webhook handler -------------------------------------------------
async function handleWebhook(env, body) {
  // We only act on new_comment events.
  const evt = body?.rule?.type;
  if (evt !== "new_comment") return json({ ignored: true, reason: "not new_comment" });

  const comment = body.comment || {};
  const text = (comment.body || "").trim();
  if (!text) return json({ ignored: true, reason: "empty comment" });

  // Resolve users for @-matching. Cache via env if provided.
  let users;
  if (env.ORG_USERS_JSON) {
    try { users = JSON.parse(env.ORG_USERS_JSON); } catch { users = []; }
  } else {
    const u = await missiveFetch(env, "/users");
    users = (u.users || u || []).map(x => ({ id: x.id, name: x.name, email: x.email }));
  }

  const parsed = parseShortcut(text, { users });
  if (!parsed.hadAnyToken) return json({ ignored: true, reason: "no shortcut tokens" });

  // Title fallback: subject of the conversation.
  const conversation = body.conversation || {};
  const subject = conversation.subject || "(no subject)";
  const title = decorateTitle(parsed.title || subject, parsed.priority);

  // Default assignee: the comment author, if no explicit @mention.
  let assignees = parsed.assignees.map(u => u.id);
  if (!assignees.length && comment.author?.email) {
    const me = users.find(u => (u.email || "").toLowerCase() === comment.author.email.toLowerCase());
    if (me) assignees = [me.id];
  }

  const payload = {
    title,
    description: `Created from comment in ${conversation.subject || "(conversation)"}.`,
    status: "todo",
    subtask: true,
    conversation: conversation.id,
  };
  if (parsed.dueAt)    payload.due_at = parsed.dueAt;
  if (assignees.length) payload.assignees = assignees;

  const created = await missiveFetch(env, "/tasks", {
    method: "POST",
    body: JSON.stringify({ tasks: payload }),
  });
  return json({ ok: true, task_id: (created.tasks || created.task || created).id });
}

// --------- Router ----------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ---- Webhook (no CORS, signature-validated) ------------------------
      if (url.pathname === "/webhook/missive" && req.method === "POST") {
        const raw = await req.text();
        if (env.WEBHOOK_SECRET) {
          const ok = await validateSignature(req, raw, env.WEBHOOK_SECRET);
          if (!ok) return json({ error: "bad signature" }, 401);
        }
        const body = JSON.parse(raw);
        return handleWebhook(env, body);
      }

      // ---- API surface (bearer-token + Origin defense-in-depth) ---------
      if (!url.pathname.startsWith("/api/")) {
        return json({ error: "not found" }, 404, cors);
      }

      // Primary auth: Bearer token in the Authorization header. The token
      // lives in the integration URL (?token=…) and never leaves Missive +
      // the browser tab, so it's reasonable for an internal team tool.
      const auth = req.headers.get("authorization") || "";
      const m_bearer = auth.match(/^Bearer\s+(.+)$/i);
      const presented = m_bearer ? m_bearer[1] : "";
      if (!env.SIDEBAR_TOKEN) {
        return json({ error: "server misconfigured: SIDEBAR_TOKEN unset" }, 500, cors);
      }
      if (!presented || !timingSafeEqual(presented, env.SIDEBAR_TOKEN)) {
        return json({ error: "unauthorized" }, 401, cors);
      }

      // Defense in depth: also reject browser-driven calls from the wrong
      // origin. Origin can be spoofed server-side, so this is NOT the
      // primary auth — it just prevents a stolen token from being used by
      // another web app in someone's browser.
      if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
        return json({ error: "forbidden origin" }, 403, cors);
      }

      // The user-email header is best-effort: it lets us filter tasks by
      // "me" when present, but is NOT required for auth (the bearer token
      // already authenticated the caller).
      const userEmail = req.headers.get("x-missive-user-email") || "";

      // GET /api/users
      if (url.pathname === "/api/users" && req.method === "GET") {
        return handleListUsers(env, cors);
      }

      // GET /api/tasks
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        return handleListTasks(env, userEmail, url.searchParams, cors);
      }

      // POST /api/tasks
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const body = await req.json();
        return handleCreateTask(env, userEmail, body, cors);
      }

      // PATCH /api/tasks/:id
      const m = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const body = await req.json();
        return handlePatchTask(env, decodeURIComponent(m[1]), body, cors);
      }

      return json({ error: "method not allowed" }, 405, cors);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, cors);
    }
  },
};
