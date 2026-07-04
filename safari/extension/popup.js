// Amber Focus — Safari popup. Collects the case for unblocking the current
// site and injects it into the Amber overlay chat (POST :8055/chat), where
// the argument continues. Draft persists in storage.local until a verified
// 2xx — input is never lost.

const $ = (id) => document.getElementById(id);
const api = typeof browser !== "undefined" ? browser : chrome;

const OVERLAY_CHAT = "http://localhost:8055/chat";
const FOCUS_CHECK = "http://localhost:8053/api/check/";

// two-label TLDs we actually hit; everything else = last two labels
const SLD = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.jp", "com.br", "co.nz"]);

function registrableDomain(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    const p = h.split(".");
    if (p.length <= 2) return h;
    const lastTwo = p.slice(-2).join(".");
    return SLD.has(lastTwo) ? p.slice(-3).join(".") : lastTwo;
  } catch {
    return null;
  }
}

let tabUrl = null;
let domain = null;
let status = null;

function draftKey() { return "draft:" + (domain || "unknown"); }

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  tabUrl = tabs[0] && tabs[0].url;
  domain = tabUrl ? registrableDomain(tabUrl) : null;
  $("domain").textContent = domain || "no site";

  // restore draft (per-domain)
  try {
    const got = await api.storage.local.get(draftKey());
    if (got && got[draftKey()]) $("case").value = got[draftKey()];
  } catch {}
  $("case").focus();

  if (!domain) {
    $("state").textContent = "couldn't read the current tab";
    $("send").disabled = true;
    return;
  }

  // block status from amber-focus
  try {
    const r = await fetch(FOCUS_CHECK + encodeURIComponent(domain));
    status = await r.json(); // {domain, blocked, allowanceMinutes, shieldActive}
    if (status.allowanceMinutes > 0)
      $("state").innerHTML = '<span class="open">granted</span> · ' + Math.round(status.allowanceMinutes) + " min left";
    else if (status.blocked)
      $("state").innerHTML = '<span class="blocked">blocked</span>';
    else
      $("state").innerHTML = '<span class="open">not blocked</span>';
  } catch {
    $("state").textContent = "amber-focus not reachable (:8053)";
  }
}

// persist draft on every keystroke — before any network attempt
$("case").addEventListener("input", () => {
  const v = $("case").value;
  api.storage.local.set({ [draftKey()]: v }).catch(() => {});
});

$("case").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});

async function send() {
  const text = $("case").value.trim();
  if (!text || !domain) return;
  $("send").disabled = true;
  note("sending…", "");

  const statusLine = status
    ? (status.allowanceMinutes > 0 ? "currently granted, " + Math.round(status.allowanceMinutes) + " min left"
       : status.blocked ? "blocked" : "not blocked")
    : "status unknown";
  const message =
    `🛡️ Unblock request from Safari — ${domain} (${statusLine})\n` +
    `${text}\n` +
    `(url: ${tabUrl})`;

  try {
    const r = await fetch(OVERLAY_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, summon: true }),
      keepalive: true,
    });
    if (!r.ok) throw new Error("overlay returned " + r.status);
    // verified delivered — only now drop the draft
    await api.storage.local.remove(draftKey()).catch(() => {});
    $("case").value = "";
    note("sent — Amber's chat is opening", "ok");
    setTimeout(() => window.close(), 900);
  } catch (e) {
    note("couldn't reach Amber — draft saved", "err");
    $("send").disabled = false;
  }
}

function note(t, cls) {
  const n = $("note");
  n.textContent = t;
  n.className = cls;
}

$("send").addEventListener("click", send);
init();
