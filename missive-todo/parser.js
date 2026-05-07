// Shortcut parser for the Missive To-Do sidebar.
//
// Shared between the sidebar (browser) and the Cloudflare Worker (V8 isolate).
// Pure ES module, no DOM or Node dependencies.
//
// Grammar:
//   Tokens are space-separated. Any token may appear in any order. After all
//   recognized tokens are stripped, the remaining text becomes the task title.
//   If the title is empty, the caller is expected to fall back to a default
//   (the email subject, in our case).
//
//   Date tokens (only the LAST one wins if multiple are given):
//     #today                 -> today @ 17:00 local
//     #tom | #tomorrow       -> tomorrow @ 09:00 local
//     #someday               -> no due date
//     #f-Nd                  -> N days from now @ 09:00 local (e.g. #f-3d)
//     #f-Nw                  -> N weeks from now @ 09:00 local (e.g. #f-1w)
//     #f-Nm                  -> N months from now @ 09:00 local
//     #mon..#sun | #f-mon..  -> next occurrence of that weekday @ 09:00
//
//   Priority (only the LAST one wins):
//     !high | !h             -> high
//     !low  | !l             -> low
//     (default: none)
//
//   Assignees (multiple allowed):
//     @name                  -> matched case-insensitively against the
//                               provided users list (by first name OR full
//                               name OR email local-part). Unmatched @names
//                               stay in the title verbatim.
//
// Output shape:
//   {
//     title:      string,                 // never null; empty => caller falls back
//     dueAt:      number | null,          // Unix seconds; null = no due date
//     dueLabel:   string | null,          // human-readable, for UI confirmation
//     priority:   "high" | "low" | null,
//     assignees:  Array<{ id, name, email }>,
//     unknownMentions: string[],          // @names that didn't match a user
//     hadAnyToken:  boolean,              // true if at least one shortcut matched
//   }

const WEEKDAYS = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Build a 09:00-local Date N days ahead of `from`.
function atMorning(from, daysAhead) {
  const d = new Date(from);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
}

// Build a 17:00-local Date `daysAhead` days ahead of `from`.
function atEvening(from, daysAhead) {
  const d = new Date(from);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(17, 0, 0, 0);
  return d;
}

function nextWeekday(from, targetDow) {
  const d = new Date(from);
  const cur = d.getDay();
  let delta = (targetDow - cur + 7) % 7;
  if (delta === 0) delta = 7; // "next Monday" never means today
  d.setDate(d.getDate() + delta);
  d.setHours(9, 0, 0, 0);
  return d;
}

function addMonths(from, n) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + n);
  d.setHours(9, 0, 0, 0);
  return d;
}

function fmtLabel(date) {
  if (!date) return null;
  const opts = { weekday: "short", month: "short", day: "numeric" };
  // Avoid Intl.DateTimeFormat options that vary across runtimes; this works
  // identically in browsers and the Workers runtime.
  return date.toLocaleDateString(undefined, opts);
}

function matchUser(token, users) {
  const t = token.toLowerCase();
  for (const u of users) {
    const first = (u.name || "").split(/\s+/)[0].toLowerCase();
    const full = (u.name || "").toLowerCase().replace(/\s+/g, "");
    const local = (u.email || "").split("@")[0].toLowerCase();
    if (first === t || full === t || local === t) return u;
  }
  return null;
}

export function parseShortcut(input, opts = {}) {
  const users = opts.users || [];
  const now = opts.now ? new Date(opts.now) : new Date();

  const out = {
    title: "",
    dueAt: null,
    dueLabel: null,
    priority: null,
    assignees: [],
    unknownMentions: [],
    hadAnyToken: false,
  };

  if (!input || typeof input !== "string") return out;

  const tokens = input.trim().split(/\s+/);
  const remainder = [];

  for (const raw of tokens) {
    const tok = raw.toLowerCase();

    // ---- Date shortcuts ------------------------------------------------
    if (tok === "#today") {
      out.dueAt = Math.floor(atEvening(now, 0).getTime() / 1000);
      out.dueLabel = "Today";
      out.hadAnyToken = true;
      continue;
    }
    if (tok === "#tom" || tok === "#tomorrow") {
      out.dueAt = Math.floor(atMorning(now, 1).getTime() / 1000);
      out.dueLabel = "Tomorrow";
      out.hadAnyToken = true;
      continue;
    }
    if (tok === "#someday") {
      out.dueAt = null;
      out.dueLabel = "Someday";
      out.hadAnyToken = true;
      continue;
    }

    // #f-Nd / #f-Nw / #f-Nm
    let m = tok.match(/^#f-(\d+)([dwm])$/);
    if (m) {
      const n = parseInt(m[1], 10);
      let target;
      if (m[2] === "d") target = atMorning(now, n);
      else if (m[2] === "w") target = atMorning(now, n * 7);
      else target = addMonths(now, n);
      out.dueAt = Math.floor(target.getTime() / 1000);
      out.dueLabel = fmtLabel(target);
      out.hadAnyToken = true;
      continue;
    }

    // #mon, #f-mon, etc.
    m = tok.match(/^#(?:f-)?([a-z]+)$/);
    if (m && WEEKDAYS[m[1]] !== undefined) {
      const target = nextWeekday(now, WEEKDAYS[m[1]]);
      out.dueAt = Math.floor(target.getTime() / 1000);
      out.dueLabel = fmtLabel(target);
      out.hadAnyToken = true;
      continue;
    }

    // ---- Priority ------------------------------------------------------
    if (tok === "!high" || tok === "!h") {
      out.priority = "high";
      out.hadAnyToken = true;
      continue;
    }
    if (tok === "!low" || tok === "!l") {
      out.priority = "low";
      out.hadAnyToken = true;
      continue;
    }

    // ---- Assignees -----------------------------------------------------
    if (raw.startsWith("@") && raw.length > 1) {
      const name = raw.slice(1);
      const u = matchUser(name, users);
      if (u) {
        if (!out.assignees.some((a) => a.id === u.id)) out.assignees.push(u);
        out.hadAnyToken = true;
        continue;
      }
      // No match: keep it in the title so the user sees what they typed.
      out.unknownMentions.push(name);
      remainder.push(raw);
      continue;
    }

    // Anything else is title material.
    remainder.push(raw);
  }

  out.title = remainder.join(" ").trim();
  return out;
}

// Helper used by the sidebar and worker to apply a priority indicator to
// titles, since Missive's native task model doesn't have a priority field.
// We keep priority visible by prefixing the title with a colored dot.
export function decorateTitle(title, priority) {
  if (priority === "high") return "🔴 " + title;
  if (priority === "low") return "🔵 " + title;
  return title;
}
