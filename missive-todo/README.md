# Inbox To-Do for Missive

A custom Missive sidebar that turns emails into tasks with shortcut syntax.
Type `#f-3d follow up @sarah !high` in the sidebar OR in a Missive comment, and
a task is created in Missive's native task system — assigned to the right
person, due in 3 days, with the email subject auto-filled as the title.

```
+--------------------------------------------+
| Inbox To-Do                  Logan         |
| [ #f-3d follow up @sarah !high           ] |
| (chip preview: "follow up", May 9, @sarah) |
| Today | Upcoming | Inbox | All             |
| ☐ 🔴 Send revised quote                    |
|    Today  @sarah  📧                        |
| ☐ Follow up on art proof                   |
|    May 9  @logan                            |
+--------------------------------------------+
```

## Architecture

```
[ Missive iframe sidebar ]              [ Missive comment box ]
  index.html (GitHub Pages)               user types #f-3d ...
        |                                         |
        | fetch /api/tasks                        | webhook (new_comment)
        v                                         v
              [  Cloudflare Worker  ]
                  worker.js
                       |
                       | Bearer token
                       v
                [ Missive REST API ]
                public.missiveapp.com/v1
```

Two entry points, one shared parser (`parser.js`), one source of truth
(Missive's native task system). The sidebar is a single static HTML file. The
Worker holds the API token and validates webhook signatures.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The sidebar UI. Hosted on GitHub Pages. |
| `parser.js` | Shortcut grammar. Imported by both sidebar and worker. |
| `worker.js` | Cloudflare Worker — REST proxy + webhook receiver. |
| `wrangler.toml` | Worker config (no secrets). |
| `parser.test.mjs` | `node parser.test.mjs` to run parser tests. |

## Shortcut grammar

Tokens can appear in any order. Whatever's left after stripping tokens
becomes the task title. If the title is empty, the email subject is used.

| Token | Meaning |
| --- | --- |
| `#today` | Due today, 17:00 local |
| `#tom`, `#tomorrow` | Due tomorrow, 09:00 local |
| `#someday` | No due date |
| `#f-3d`, `#f-1w`, `#f-2m` | N days / weeks / months out, 09:00 |
| `#mon`..`#sun`, `#f-mon`.. | Next occurrence of that weekday, 09:00 |
| `@firstname` | Assigns to that user. Multiple allowed. |
| `!high`, `!low` | Priority — shown as 🔴 / 🔵 prefix on the title |

## Deploy

### 1. Push to GitHub and turn on Pages

```bash
git init
git add .
git commit -m "initial"
gh repo create missive-todo --public --source=. --push
gh repo edit --enable-pages --pages-branch main
```

Or drag the folder into a fresh GitHub repo and turn on Pages from the repo
Settings → Pages → Deploy from main / root.

After ~30 sec your sidebar lives at:
`https://<your-username>.github.io/missive-todo/`

### 2. Create a Missive API token

Missive → Settings → API → **Create new token**. Copy it.

You also need:
- The **team UUID** for your org's default team. Get it from `GET https://public.missiveapp.com/v1/teams` (use the new token).

### 3. Deploy the Worker

Generate a `SIDEBAR_TOKEN` first — any long random string works:
```bash
openssl rand -hex 32     # copy the output, you'll need it twice
```

```bash
npm install -g wrangler
wrangler login
wrangler secret put MISSIVE_API_TOKEN     # paste your Missive API token
wrangler secret put MISSIVE_TEAM_ID       # paste the team UUID
wrangler secret put SIDEBAR_TOKEN         # paste the random hex from above
wrangler secret put ALLOWED_ORIGIN        # https://<you>.github.io
wrangler secret put WEBHOOK_SECRET        # another random string, save it
wrangler deploy
```

`wrangler deploy` prints the worker URL, e.g.
`https://missive-todo.you.workers.dev`. Save it.

### 4. Install the sidebar in Missive

Missive → Settings → Integrations → **Build your own** → New integration.

- Name: `Inbox To-Do`
- iFrame URL:
  `https://<you>.github.io/missive-todo/?api=https://missive-todo.you.workers.dev&token=<SIDEBAR_TOKEN>`
  - `api=` points at your worker
  - `token=` is the same `SIDEBAR_TOKEN` you set as a worker secret
- Contexts: **conversation**

Save. The sidebar appears in your conversation panel.

> **Why the token is in the URL.** The repo is public for GitHub Pages, but
> the integration URL (with the token) lives only in Missive's integration
> settings — visible only to your org's Missive admins. The worker validates
> every `/api/*` call against this token in constant time. To rotate: pick a
> new value, `wrangler secret put SIDEBAR_TOKEN`, and update the integration
> URL in Missive. The webhook uses a separate `WEBHOOK_SECRET` validated via
> HMAC, so it's unaffected by sidebar-token rotation.

### 5. Wire the comment-box webhook

Missive → Settings → **Rules** → New rule (organization-level, not personal).

- Trigger: **New comment**
- Conditions: leave empty (we filter inside the worker)
- Action: **Webhook**
  - URL: `https://missive-todo.you.workers.dev/webhook/missive`
  - Validation secret: paste the same value you used for `WEBHOOK_SECRET`

Save.

### 6. Test

1. Open any conversation in Missive.
2. In the sidebar's input, type `#f-3d ping client @yourself` and hit Enter.
   The task should appear in the list and in Missive's native Tasks panel.
3. In the conversation's comment box, type `#today review proof @teammate`
   and post the comment. Within a couple of seconds (webhook fires, worker
   creates the task), it shows up in the sidebar after refresh.

## Tweaking the shortcut grammar

`parser.js` is the single source of truth. Add a new token by editing
`parseShortcut()` and adding a test case in `parser.test.mjs`. Run
`node parser.test.mjs` to confirm. Both the sidebar and the worker pick up
the change on next deploy (the worker bundles `parser.js` automatically via
wrangler).

## Limitations / things to know

- **Priority**: Missive doesn't have a native priority field on tasks, so we
  encode it as a 🔴/🔵 emoji prefix on the title. Visible everywhere; not
  filterable as such.
- **Cross-conversation list**: the sidebar's `Today` / `Upcoming` / `All`
  tabs hit `GET /v1/tasks?limit=200`. If you're going to have thousands of
  open tasks, swap that for paginated server-side filtering.
- **Comment-box parsing happens AFTER the comment is posted**. The original
  comment stays in the conversation as a record. If you want it auto-deleted,
  add a follow-up `DELETE /v1/comments/:id` call in `handleWebhook`.
- **Personal vs org rules**: the webhook rule must be an organization rule
  (admin/owner required) for it to fire on comments authored by anyone.
  Personal rules only fire on your own comments.

## Local dev

```bash
# Sidebar (any static server works):
python3 -m http.server 8000
# then add ?api=http://localhost:8787 to the integration URL during dev

# Worker:
wrangler dev
```
