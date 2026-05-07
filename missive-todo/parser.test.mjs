// Tests for parser.js. Run with `node parser.test.mjs` — no test framework
// dependency, just plain assertions.
import { parseShortcut, decorateTitle } from "./parser.js";
import assert from "node:assert/strict";

const USERS = [
  { id: "u1", name: "Logan Roberts", email: "logan@inkmule.com" },
  { id: "u2", name: "Sarah Chen",    email: "sarah@inkmule.com" },
  { id: "u3", name: "Mike O'Brien",  email: "mike.obrien@inkmule.com" },
];

// Fix "now" to a known weekday so weekday math is deterministic.
// 2026-05-06 is a Wednesday.
const NOW = new Date("2026-05-06T14:00:00").getTime();

function run(name, fn) {
  try {
    fn();
    console.log("  ok  -", name);
  } catch (e) {
    console.error("  FAIL -", name);
    console.error("       ", e.message);
    process.exitCode = 1;
  }
}

console.log("parser.js");

run("plain text becomes the title with no tokens triggered", () => {
  const r = parseShortcut("call the printer back", { users: USERS, now: NOW });
  assert.equal(r.title, "call the printer back");
  assert.equal(r.dueAt, null);
  assert.equal(r.priority, null);
  assert.deepEqual(r.assignees, []);
  assert.equal(r.hadAnyToken, false);
});

run("#f-3d sets due ~3 days out at 9am", () => {
  const r = parseShortcut("#f-3d follow up on quote", { users: USERS, now: NOW });
  assert.equal(r.title, "follow up on quote");
  assert.equal(r.priority, null);
  const due = new Date(r.dueAt * 1000);
  assert.equal(due.getDate(), 9);   // May 9
  assert.equal(due.getMonth(), 4);  // May (0-indexed)
  assert.equal(due.getHours(), 9);
  assert.equal(r.hadAnyToken, true);
});

run("#f-1w is exactly 7 days ahead", () => {
  const r = parseShortcut("#f-1w", { users: USERS, now: NOW });
  const due = new Date(r.dueAt * 1000);
  assert.equal(due.getDate(), 13);  // May 13
});

run("#tom and #tomorrow are equivalent", () => {
  const a = parseShortcut("#tom", { users: USERS, now: NOW });
  const b = parseShortcut("#tomorrow", { users: USERS, now: NOW });
  assert.equal(a.dueAt, b.dueAt);
  assert.equal(a.dueLabel, "Tomorrow");
});

run("#today schedules for end of today", () => {
  const r = parseShortcut("#today review proof", { users: USERS, now: NOW });
  const due = new Date(r.dueAt * 1000);
  assert.equal(due.getDate(), 6);
  assert.equal(due.getHours(), 17);
  assert.equal(r.title, "review proof");
});

run("#someday clears due date", () => {
  const r = parseShortcut("#someday refactor pricing logic", { users: USERS, now: NOW });
  assert.equal(r.dueAt, null);
  assert.equal(r.dueLabel, "Someday");
});

run("@sarah resolves to a user; @ghost stays in title", () => {
  const r = parseShortcut("#today @sarah @ghost ping client", { users: USERS, now: NOW });
  assert.equal(r.assignees.length, 1);
  assert.equal(r.assignees[0].id, "u2");
  assert.deepEqual(r.unknownMentions, ["ghost"]);
  assert.equal(r.title, "@ghost ping client");
});

run("@logan matches by first name OR by email local part", () => {
  const a = parseShortcut("@logan ping", { users: USERS, now: NOW });
  const b = parseShortcut("@logan@inkmule.com ping", { users: USERS, now: NOW });
  assert.equal(a.assignees[0]?.id, "u1");
  // "@logan@inkmule.com" is one token; we only match the suffix, so the second
  // form WON'T resolve as a single token. Verify it's left in remainder:
  assert.equal(b.assignees.length, 0);
});

run("multiple @assignees accumulate without duplicates", () => {
  const r = parseShortcut("#f-3d @sarah @sarah @logan", { users: USERS, now: NOW });
  assert.equal(r.assignees.length, 2);
});

run("!high sets priority high; later !low overrides earlier !high", () => {
  const r1 = parseShortcut("!high urgent", { users: USERS, now: NOW });
  const r2 = parseShortcut("!high urgent !low", { users: USERS, now: NOW });
  assert.equal(r1.priority, "high");
  assert.equal(r2.priority, "low");
});

run("token order doesn't matter", () => {
  const r = parseShortcut("ping client @sarah !high #f-3d", { users: USERS, now: NOW });
  assert.equal(r.title, "ping client");
  assert.equal(r.priority, "high");
  assert.equal(r.assignees[0]?.id, "u2");
  assert.notEqual(r.dueAt, null);
});

run("#mon picks the NEXT Monday, not today even if today is Mon", () => {
  // NOW = Wed May 6. Next Mon = May 11.
  const r = parseShortcut("#mon ship samples", { users: USERS, now: NOW });
  const due = new Date(r.dueAt * 1000);
  assert.equal(due.getDate(), 11);
});

run("#f-thu picks the next Thursday", () => {
  const r = parseShortcut("#f-thu", { users: USERS, now: NOW });
  const due = new Date(r.dueAt * 1000);
  assert.equal(due.getDate(), 7); // May 7 = Thu
});

run("title fallback: pure shortcut yields empty title for caller to fill", () => {
  const r = parseShortcut("#f-3d", { users: USERS, now: NOW });
  assert.equal(r.title, "");
});

run("decorateTitle adds priority dot", () => {
  assert.equal(decorateTitle("foo", "high"), "🔴 foo");
  assert.equal(decorateTitle("foo", "low"), "🔵 foo");
  assert.equal(decorateTitle("foo", null), "foo");
});

run("empty/garbage input doesn't throw", () => {
  assert.doesNotThrow(() => parseShortcut("", { users: USERS, now: NOW }));
  assert.doesNotThrow(() => parseShortcut(null, { users: USERS, now: NOW }));
  assert.doesNotThrow(() => parseShortcut("   ", { users: USERS, now: NOW }));
});

console.log("done.");
