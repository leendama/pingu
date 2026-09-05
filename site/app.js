(() => {
  "use strict";

  // Apps Script web app URL, ending in /exec. See apps-script/README.md.
  // Empty string = demo mode: the page animates, nothing is stored.
  const WAITLIST_ENDPOINT = "";

  const REPO_URL = "https://github.com/leendama/pingu";
  const STORAGE_KEY = "pingu-waitlist";

  const SCRIPT = [
    "Pingu, personal assistant on iMessage",
    "Self-hosted, open source",
    "Google Calendar, Gmail, Granola, and others",
    "Other people can text it to book time in your calendar",
    "Reminders, polls, rich links, voice replies, tapbacks",
    "Your email?",
  ];
  const REPLY = "Noot noot, we'll be in touch";
  const RETRY = "Didn't go through, try again";

  const thread = document.getElementById("thread");
  const form = document.getElementById("compose");
  const input = document.getElementById("email");
  const button = document.getElementById("send");
  const stamp = document.getElementById("stamp");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let typingEl = null;
  let introRunning = false;
  let introAborted = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = (ms) => sleep(reducedMotion ? 0 : ms);

  stamp.textContent = "Today " + new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());

  function scrollToEnd(instant) {
    thread.scrollTo({ top: thread.scrollHeight, behavior: instant || reducedMotion ? "auto" : "smooth" });
  }

  function groupPrevious(side) {
    const last = thread.lastElementChild;
    if (last && last.classList.contains("msg") && last.classList.contains(side)) last.classList.add("grouped");
  }

  function bubble(side, text) {
    const el = document.createElement("div");
    el.className = "msg " + side;
    el.textContent = text;
    groupPrevious(side);
    thread.appendChild(el);
    scrollToEnd();
    return el;
  }

  function status(text) {
    const el = document.createElement("div");
    el.className = "status";
    el.textContent = text;
    thread.appendChild(el);
    scrollToEnd();
    return el;
  }

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("div");
    typingEl.className = "typing";
    typingEl.setAttribute("aria-label", "Pingu is typing");
    typingEl.innerHTML = "<i></i><i></i><i></i>";
    thread.appendChild(typingEl);
    scrollToEnd();
  }

  function hideTyping() {
    if (!typingEl) return;
    typingEl.remove();
    typingEl = null;
  }

  async function pinguSays(text, dwell) {
    showTyping();
    await wait(dwell);
    hideTyping();
    return bubble("in", text);
  }

  function richLink() {
    const el = document.createElement("a");
    el.className = "msg in link";
    el.href = REPO_URL;
    el.target = "_blank";
    el.rel = "noopener";
    el.innerHTML =
      '<span class="link-art"><img src="pingu.svg" alt="" width="56" height="56"></span>' +
      '<span class="link-meta"><span class="link-title">leendama/pingu</span><span class="link-host">github.com</span></span>';
    groupPrevious("in");
    thread.appendChild(el);
    scrollToEnd();
    return el;
  }

  function setComposeEnabled(enabled) {
    input.disabled = !enabled;
    button.disabled = !enabled || input.value.trim() === "";
  }

  function shake() {
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
  }

  function persist(email) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ email, at: new Date().toISOString() }));
    } catch (_) {
      // Storage unavailable. The thread still completed.
    }
  }

  function restored() {
    const params = new URLSearchParams(location.search);
    if (params.get("preview") === "done") return "you@example.com";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return saved && typeof saved.email === "string" ? saved.email : null;
    } catch (_) {
      return null;
    }
  }

  async function submit(email, honeypot) {
    if (!WAITLIST_ENDPOINT) {
      console.warn("Pingu waitlist: WAITLIST_ENDPOINT is empty. Demo mode, nothing stored.");
      await sleep(500);
      return true;
    }
    // text/plain keeps this a simple request: no CORS preflight, which Apps Script cannot answer.
    const response = await fetch(WAITLIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ email, website: honeypot, referrer: document.referrer, ua: navigator.userAgent }),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data && data.ok);
  }

  async function intro() {
    introRunning = true;
    await wait(400);
    for (const line of SCRIPT) {
      if (introAborted) break;
      await pinguSays(line, 700);
      await wait(200);
    }
    introRunning = false;
    if (!introAborted && finePointer) input.focus({ preventScroll: true });
  }

  function renderDone(email) {
    for (const line of SCRIPT) bubble("in", line);
    bubble("out", email);
    status("Delivered");
    bubble("in", REPLY);
    richLink();
    setComposeEnabled(false);
    scrollToEnd(true);
  }

  input.addEventListener("input", () => {
    button.disabled = input.value.trim() === "";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input.value.trim().toLowerCase();
    if (!EMAIL.test(email)) {
      shake();
      input.focus({ preventScroll: true });
      return;
    }
    if (introRunning) {
      introAborted = true;
      hideTyping();
    }
    const honeypot = form.elements.website.value;

    setComposeEnabled(false);
    input.value = "";
    bubble("out", email);

    let ok = false;
    const request = submit(email, honeypot).catch(() => false);
    await wait(600);
    ok = await request;

    if (ok) {
      status("Delivered");
      await pinguSays(REPLY, 800);
      await wait(500);
      richLink();
      persist(email);
      return;
    }

    const label = status("Not Delivered");
    label.classList.add("error");
    await pinguSays(RETRY, 800);
    input.value = email;
    setComposeEnabled(true);
    if (finePointer) input.focus({ preventScroll: true });
  });

  const saved = restored();
  if (saved) {
    renderDone(saved);
  } else {
    setComposeEnabled(true);
    intro();
  }
})();
