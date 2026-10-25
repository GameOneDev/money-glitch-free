// ==UserScript==
// @name         Kahoot AI Helper - Claude (HTTP + WebSocket)
// @namespace    http://tampermonkey.net/
// @version      4.7
// @description  Answers Kahoot, Mentimeter (menti.com) and AhaSlides quiz questions with Claude. On Kahoot it auto-answers over the game's WebSocket and reads questions from its WebSocket or HTTP long-polling traffic, falling back to the page; on menti.com it reads the quiz from the voting page's traffic, answers the whole quiz ahead of time and taps the answer when its question comes up; on AhaSlides it reads the slide from the page and enters the answer, including short answer, correct order, match pairs and categorise, and sends the slide's pictures along. A choice of model, optional web search and fast mode, and an optional answer highlight.
// @match        https://kahoot.it/*
// @match        https://www.menti.com/*
// @match        https://menti.com/*
// @match        https://audience.ahaslides.com/*
// @match        https://audience.ahaslides.eu/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js
// @downloadURL  https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ── SETTINGS ──────────────────────────────────────────────────
  // The API key isn't here: paste it in the panel. It's kept in the browser, so updating the script
  // doesn't wipe it and it can't end up in a repo.
  // The panel's model menu. The first one is where it starts; after that it remembers. At low effort and
  // with web search, Sonnet and Opus each got all 104 questions right (70 general and niche, 34 about
  // recent and local facts). Sonnet answers in about 2.7 s with nearly all under 4.5 s, Opus in about
  // 3.2 s with some up to 9.5 s, and Sonnet costs half as much. Without search the 70 general ones went
  // 67, 69 and 70 right for Haiku, Sonnet and Opus.
  const MODELS = [
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Opus 5.5" },
    { id: "claude-haiku-5-5", name: "Haiku 5.5" },
    // { id: "claude-fable-5-1", name: "Fable 5.1" },
  ];
  // Fast mode (speed: "fast") is a research preview that only some models have, at twice the price.
  const FAST_MODELS = new Set(["claude-opus-5-5"]);
  const FAST_BETA = "fast-mode-2026-02-01";
  // These seven are where the panel's Advanced section starts. Change them there: it remembers.
  // How long Claude thinks before it answers: low, medium or high.
  const EFFORT = "low";
  // Web searches Claude may run per question.
  const MAX_SEARCHES = 2;
  // What a searching Claude is told. Left to decide whether to search, it answers some recent or local
  // facts (how many shops a chain has, when its first one opened) from memory, confidently and wrongly:
  // Sonnet got 13 of 18 such questions right that way, and 18 of 18 when told to always search, which
  // also kept it at 70 of 70 on general and niche ones.
  const SEARCH_LEAD = "Always search the web before you answer, and answer from what you find. ";
  // With search on, the same question is also asked without it, and this long after the question went
  // live that quick answer is used if the search still hasn't come back.
  const SEARCH_GRACE_MS = 4000;
  // How long to wait for Claude, and for Claude with web search, before giving up.
  const API_TIMEOUT_MS = 20000;
  const SEARCH_TIMEOUT_MS = 40000;
  // A random pause before sending the answer, so it isn't instant. Both at 0 answers at once. The
  // panel's slider for it goes from 0 to 2 s.
  const ANSWER_DELAY_MIN = 150;
  const ANSWER_DELAY_MAX = 700;
  // Never wait so long that less than this much of the question's timer is left to answer in.
  const TIMER_MARGIN_MS = 2500;
  // Print Kahoot's game messages (both directions) in the console, for working out why an answer
  // isn't taken.
  const TRACE = false;

  // Not in the panel.
  // Claude 5.x models think before they answer, and that thinking counts toward max_tokens, so the
  // longer it's allowed to think the more room it needs. With web search it also writes its queries.
  const TOKENS_BY_EFFORT = { low: 1024, medium: 4096, high: 8192 };
  const SEARCH_EXTRA_TOKENS = 3072;
  const MAX_CONTINUATIONS = 3;
  // How long to wait for the answer buttons to show up and become clickable.
  const BUTTON_WAIT_MS = 30000;
  // CometD can redeliver a message after a reconnect. A question matching the one that just finished,
  // arriving this soon after, is that and not a new question.
  const REPEAT_WINDOW_MS = 10000;

  // Which game this page is. Most of the script is the same for all of them; the parts that read the
  // question and send the answer differ.
  const SITE = /(^|\.)menti\.com$/.test(location.hostname) ? "menti"
    : /(^|\.)ahaslides\.(com|eu)$/.test(location.hostname) ? "aha"
    : "kahoot";
  const LOG = { menti: "[Menti AI]", aha: "[AhaSlides AI]", kahoot: "[Kahoot AI]" }[SITE];
  const API_URL = "https://api.anthropic.com/v1/messages";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── PANEL SETTINGS ────────────────────────────────────────────
  // What the panel's switches and menu hold. Saved in this browser, so they stick between games.
  const PREFS = {
    autoAnswer: { key: "kahoot-ai-auto-answer", fallback: true },   // send Claude's answer for you
    highlight:  { key: "kahoot-ai-highlight",   fallback: true },   // outline the answer on screen
    webSearch:  { key: "kahoot-ai-web-search",  fallback: true },   // let Claude search the web
    fast:       { key: "kahoot-ai-fast",        fallback: false },  // speed: "fast"
    prefetch:   { key: "kahoot-ai-prefetch",    fallback: true },   // Menti: answer the whole quiz before it starts
    model:      { key: "kahoot-ai-model",       fallback: MODELS[0].id, options: MODELS.map((m) => m.id) },
    // "hidden" folds the panel to the ⚡ button; "off" makes that button invisible, though a tap on it
    // still works.
    ui:         { key: "kahoot-ai-ui",          fallback: "compact", options: ["compact", "open", "hidden", "off"] },
    // The Advanced section. Times are kept in milliseconds, and the panel shows seconds.
    delayMin:      { key: "kahoot-ai-delay-min",      fallback: ANSWER_DELAY_MIN,  min: 0,     max: 2000 },
    delayMax:      { key: "kahoot-ai-delay-max",      fallback: ANSWER_DELAY_MAX,  min: 0,     max: 2000 },
    margin:        { key: "kahoot-ai-margin",         fallback: TIMER_MARGIN_MS,   min: 0,     max: 30000 },
    effort:        { key: "kahoot-ai-effort",         fallback: EFFORT,            options: Object.keys(TOKENS_BY_EFFORT) },
    maxSearches:   { key: "kahoot-ai-max-searches",   fallback: MAX_SEARCHES,      min: 1,     max: 10 },
    timeout:       { key: "kahoot-ai-timeout",        fallback: API_TIMEOUT_MS,    min: 5000,  max: 120000 },
    searchTimeout: { key: "kahoot-ai-search-timeout", fallback: SEARCH_TIMEOUT_MS, min: 10000, max: 180000 },
    trace:         { key: "kahoot-ai-trace",          fallback: TRACE },
  };
  const prefs = {};
  for (const [name, { key, fallback, min, max, options }] of Object.entries(PREFS)) {
    let value = fallback;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) value = typeof fallback === "boolean" ? saved === "1" : typeof fallback === "number" ? Number(saved) : saved;
    } catch (_) {}
    // Anything saved that this version doesn't know (a model that's gone, a number out of range) goes
    // back to the default. A NaN fails the range check too.
    if (options && !options.includes(value)) value = fallback;
    if (typeof fallback === "number" && !(value >= min && value <= max)) value = fallback;
    prefs[name] = value;
  }
  if (prefs.delayMin > prefs.delayMax) prefs.delayMax = prefs.delayMin;

  function setPref(name, value) {
    prefs[name] = value;
    try { localStorage.setItem(PREFS[name].key, typeof value === "boolean" ? (value ? "1" : "0") : value); } catch (_) {}
    renderControls();
    renderUi();
    if (name === "highlight") syncMark();
    if (["model", "effort", "webSearch", "fast", "maxSearches", "prefetch"].includes(name)) schedulePrefetch();
    console.log(LOG, name, "=", value);
  }

  const modelName = (id) => MODELS.find((m) => m.id === id)?.name ?? id;
  const fastModel = () => FAST_MODELS.has(prefs.model);

  // The API key. Saved in this page's local storage, so any script that runs on kahoot.it can read it
  // (the requests to Anthropic are made from the page, so they could be watched anyway). Use a key
  // made for this, with a spend limit.
  const KEY_STORAGE = "kahoot-ai-api-key";
  const KEY_SHAPE = /^sk-ant-\S{10,}$/;
  let apiKey = "";
  try { apiKey = localStorage.getItem(KEY_STORAGE) || ""; } catch (_) {}
  let editingKey = false;

  // Before 4.7 the script started on Haiku 5.5 with web search off, a small part of the cost a question
  // of Sonnet 5.5 with search. A setting is only saved once it's changed, so an install from then that already has a key
  // and never touched those two would be moved to the dearer ones by the update. It keeps them instead,
  // saved as if picked; they're a tap away in the panel. The mark says this has been looked at, so a key
  // pasted later on a new install doesn't count.
  const DEFAULTS_MARK = "kahoot-ai-defaults";
  const EARLIER_DEFAULTS = { model: "claude-haiku-5-5", webSearch: false };
  try {
    if (!localStorage.getItem(DEFAULTS_MARK)) {
      localStorage.setItem(DEFAULTS_MARK, "4.7");
      if (apiKey) {
        for (const [name, value] of Object.entries(EARLIER_DEFAULTS)) {
          if (localStorage.getItem(PREFS[name].key) !== null) continue;
          prefs[name] = value;
          localStorage.setItem(PREFS[name].key, typeof value === "boolean" ? (value ? "1" : "0") : value);
          console.log(LOG, `Kept ${name} = ${value} from before 4.7`);
        }
      }
    }
  } catch (_) {}

  function saveApiKey(value) {
    apiKey = value;
    editingKey = false;
    prefetchHalted = false;
    schedulePrefetch();
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (_) {}
    renderKey();
  }

  // ── READ QUESTIONS FROM KAHOOT'S TRAFFIC ──────────────────────
  // Kahoot's client talks CometD over a WebSocket, or over HTTP long-polling when the WebSocket
  // can't connect. Either way the question shows up as a message with JSON in data.content, so
  // watch both and keep the newest question. That works even when the page doesn't show the text.
  const SINGLE_CHOICE_TYPES = new Set(["quiz", "true_false"]);
  // Newest question seen on the wire: { seq, source, question, answers, time } or { seq, unsupported, question }.
  // The same question can show up here more than once; the main loop sorts that out.
  let incoming = null;
  let seq = 0;

  const decodeEl = document.createElement("textarea");
  function cleanText(value) {
    decodeEl.innerHTML = String(value ?? "");
    return decodeEl.value.replace(/<[^>]*>/g, "").trim();
  }

  // The question can sit at the top of the message, or nested a level down (firstGameBlockData in
  // "extensive mode"), so look through the nested objects for one that has text and choices.
  function findQuestionBlock(node, depth = 0) {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 3) return null;
    if ((typeof node.question === "string" || typeof node.title === "string") && Array.isArray(node.choices)) return node;
    for (const value of Object.values(node)) {
      const found = findQuestionBlock(value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // What it takes to send an answer ourselves, learned from Kahoot's traffic in both directions.
  let activeWs = null;
  let clientId = null;
  let gameId = null;
  let msgId = 0;
  let answerDataId = 45; // the data.id Kahoot's own client puts on an answer
  let wireIndex = null;  // the question number, when Kahoot's messages say which one it is

  function learnFrom(item) {
    if (item.clientId) clientId = item.clientId;
    if (item.data?.gameid) {
      if (gameId !== item.data.gameid) wireIndex = null;
      gameId = item.data.gameid;
    }
    const id = parseInt(item.id, 10);
    if (id > msgId) msgId = id;
  }

  function trace(arrow, item) {
    if (!prefs.trace || !item?.channel || item.channel.startsWith("/meta/")) return;
    console.log(LOG, arrow, item.channel, `data.id=${item.data?.id}`, String(item.data?.content ?? "").slice(0, 300));
  }

  function handleKahootMessages(data, source) {
    for (const item of Array.isArray(data) ? data : [data]) {
      if (!item) continue;
      learnFrom(item);
      trace("←", item);

      const raw = item.data?.content;
      if (!raw) continue;

      let content;
      try { content = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { continue; }
      const number = [content?.questionIndex, content?.gameBlockIndex].find(Number.isInteger);
      if (number !== undefined) wireIndex = number;
      const block = findQuestionBlock(content);
      if (!block) continue;

      const question = cleanText(block.question ?? block.title);

      if (block.type && !SINGLE_CHOICE_TYPES.has(block.type)) {
        incoming = { seq: ++seq, unsupported: block.type, question };
        continue;
      }

      const answers = block.choices.map((c, index) => ({
        index,
        text: cleanText(typeof c === "string" ? c : c?.answer ?? c?.text ?? "")
      }));
      if (!question || answers.every(a => !a.text)) continue;

      incoming = { seq: ++seq, source, question, answers, time: Number(block.time) || 0 };
      console.log(LOG, `Question via ${source}:`, question);
    }
  }

  // ── READ QUESTIONS FROM MENTIMETER'S TRAFFIC ──────────────────
  // menti.com's voting page loads the whole presentation as JSON: every question, with its type and
  // its choices, and under "pace" which one is up. Its socket says when that changes. Keep every
  // question seen; the one being asked is whichever has its choices on screen (see READ THE PAGE).
  // Polls, word clouds, scales and the like have no right answer, so only quiz questions are answered.
  // In the current format each slide's type ("quiz-choice", "multiple-choice", ...) is on the slide, in
  // static_content, and its title and choices are a level down, in interactive_contents.
  const MENTI_QUIZ_TYPE = /^quiz/;
  const MENTI_TYPED_ANSWER = /open|type/;
  const mentiQuestions = new Map(); // id -> { ids, question, answers, type, seen }
  let mentiActive = null;           // pace.active: the id of the question that's up, when it's known

  // Walk any JSON the page gets. Socket messages can carry their JSON as a string inside JSON, or after
  // a numeric frame prefix ("42[...]"), so strings that look like JSON are opened up too.
  function handleMentiData(node, depth = 0, parentKey = "", slideType = "", slideId = "") {
    if (node == null || depth > 12) return;
    if (typeof node === "string") {
      const text = node.trim().replace(/^\d+(?=[[{])/, "");
      // Most of what the page receives (stats, vote counts, tracking) holds no question, so only
      // something that names choices or the pace is opened up.
      if ((text[0] === "{" || text[0] === "[") && text.length < 2e6 && /choices|options|pace/.test(text)) {
        try { handleMentiData(JSON.parse(text), depth + 1); } catch (_) {}
      }
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const value of node) handleMentiData(value, depth + 1, "", slideType, slideId);
      return;
    }
    if (parentKey === "pace" && node.active != null && String(node.active) !== mentiActive) {
      mentiActive = String(node.active);
      if (prefs.trace) console.log(LOG, "Active question:", mentiActive);
    }
    slideType = node.static_content?.type ?? node.staticContent?.type ?? slideType;
    // The slide's own id goes down with its type: that's the one pace.active is likely to name.
    if ((node.static_content || node.staticContent) && node.id != null) slideId = String(node.id);
    learnMentiQuestion(node, slideType, slideId);
    for (const [key, value] of Object.entries(node)) handleMentiData(value, depth + 1, key, slideType, slideId);
  }

  function learnMentiQuestion(node, slideType, slideId) {
    const title = [node.question, node.title, node.heading].find((t) => typeof t === "string" && t.trim());
    const list = [node.choices, node.options].find(Array.isArray);
    if (!title || !list || list.length < 2) return;
    const answers = list.map((c, index) => ({
      index,
      text: cleanText(typeof c === "string" ? c : c?.label ?? c?.title ?? c?.text ?? "")
    }));
    if (answers.some((a) => !a.text)) return;
    const question = cleanText(title);
    const ids = [node.id, node.public_key, node.publicKey, node.admin_key, node.interactive_content_id, node.interactiveContentId, slideId]
      .filter((v) => v != null && v !== "").map(String);
    const id = ids[0] ?? textKey(question);
    const type = String(node.type ?? slideType ?? "");
    const known = mentiQuestions.get(id);
    mentiQuestions.set(id, { ids, question, answers, type, seen: ++seq });
    if (!known && prefs.trace) console.log(LOG, `Learned ${type || "a"} question:`, question, answers.map((a) => a.text));
    schedulePrefetch();
  }

  const isCometdUrl = url => String(url ?? "").includes("/cometd/");
  function isMentiUrl(url) {
    try {
      const { hostname, pathname } = new URL(String(url ?? ""), location.href);
      return /(^|\.)(menti|mentimeter)\.com$/.test(hostname) && !/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ico)$/i.test(pathname);
    } catch (_) { return false; }
  }
  // AhaSlides' traffic isn't read: its question comes from the page (see READ AHASLIDES' SLIDE).
  const isWatchedUrl = (url) => (SITE === "menti" ? isMentiUrl(url) : SITE === "kahoot" && isCometdUrl(url));

  // Kahoot's traffic is always JSON. Mentimeter's is anything, and its reader takes text as it comes.
  function onWire(payload, source) {
    if (SITE === "menti") handleMentiData(payload);
    else if (SITE === "kahoot") handleKahootMessages(typeof payload === "string" ? JSON.parse(payload) : payload, source);
  }

  // HTTP: XMLHttpRequest, which is what CometD uses, and fetch in case that changes. Mentimeter's
  // page fetches its JSON.
  const OldXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isWatchedUrl(url) && !this.__kahootAiHooked) {
      this.__kahootAiHooked = true;
      this.addEventListener("load", onWatchedXhrLoad);
    }
    return OldXhrOpen.apply(this, arguments);
  };

  function onWatchedXhrLoad() {
    if (this.status < 200 || this.status >= 300 || !isWatchedUrl(this.responseURL)) return;
    if (SITE === "menti" && !/json/i.test(this.getResponseHeader("content-type") ?? "")) return;
    try {
      if (this.responseType === "json") onWire(this.response, "http");
      else if (this.responseType === "" || this.responseType === "text") onWire(this.responseText, "http");
    } catch (e) { console.debug(LOG, "XHR parse error:", e.message); }
  }

  const OldFetch = window.fetch;
  window.fetch = function (input) {
    const request = OldFetch.apply(this, arguments);
    if (isWatchedUrl(typeof input === "string" ? input : input?.url)) {
      request
        .then(resp => (SITE === "menti" && !/json/i.test(resp.headers.get("content-type") ?? "") ? null : resp.clone().text()))
        .then(text => { if (text !== null) onWire(text, "http"); })
        .catch(e => console.debug(LOG, "fetch parse error:", e.message));
    }
    return request;
  };

  // WebSocket.
  const OldWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OldWebSocket(url, protocols) : new OldWebSocket(url);
    ws.addEventListener("message", event => {
      try {
        if (typeof event.data === "string") onWire(event.data, "ws");
      } catch (e) { console.debug(LOG, "WS parse error:", e.message); }
    });
    // Answers go over the socket only on Kahoot. Mentimeter's is only listened to, and AhaSlides' not even that.
    if (SITE !== "kahoot") return ws;
    activeWs = ws;

    // Watch what Kahoot's own client sends: that's where the client id and message numbers come from,
    // and where an answer's exact shape can be read off when you answer one yourself.
    const originalSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        for (const item of [].concat(JSON.parse(data))) {
          if (!item) continue;
          learnFrom(item);
          trace("→", item);
          let content = item.data?.content;
          if (typeof content === "string") content = JSON.parse(content);
          if (item.channel === "/service/controller" && content?.choice !== undefined && item.data.id) answerDataId = item.data.id;
        }
      } catch (e) { console.debug(LOG, "WS send parse error:", e.message); }
      return originalSend(data);
    };

    ws.addEventListener("close", () => {
      if (activeWs !== ws) return;
      activeWs = null;
      clientId = gameId = null;
      msgId = 0;
      wireIndex = null;
    });
    return ws;
  };
  window.WebSocket.prototype = OldWebSocket.prototype;
  Object.defineProperties(window.WebSocket, {
    CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSING: { value: 2 }, CLOSED: { value: 3 }
  });

  // ── READ THE PAGE ─────────────────────────────────────────────
  // The answer buttons on screen, by position. Kahoot and AhaSlides mark them; Mentimeter's are found
  // by their text.
  const buttonFor = (index) => SITE === "menti" ? mentiScreen().els[index] ?? null
    : SITE === "aha" ? ahaEls("audience-quiz-option")[index] ?? null
    : document.querySelector(`[data-functional-selector="answer-${index}"]`);
  const choiceTextEl = (index) => SITE === "menti" ? mentiScreen().els[index] ?? null
    : SITE === "aha" ? ahaEls("audience-quiz-option")[index] ?? null
    : document.querySelector(`[data-functional-selector="question-choice-text-${index}"]`);
  const isDisabled = (el) => !!el.disabled || el.getAttribute("aria-disabled") === "true";
  const isVisible = (el) => el.getClientRects().length > 0;
  // Where an answer button is on screen, counting from the first. Menti's are kept in the answers' order
  // (see matchChoices), which can differ from the order the page shows them in.
  const screenPlace = (index) => {
    const el = SITE === "menti" ? buttonFor(index) : null;
    return el ? mentiScreen().els.filter((other) => other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).length : index;
  };

  // Mentimeter's class names are generated and change, so there's nothing to select its answers by.
  // Instead, take each question learned from the traffic and look for its choices among the things on
  // screen that can be tapped. The question whose choices are all there is the one being asked.
  const TAPPABLE = 'button, [role="button"], [role="radio"], [role="option"], [role="checkbox"], label';
  // An answer is a few words. Anything with far more text than that is a container, not a choice.
  const CHOICE_TEXT_MAX = 400;
  // The page's own markup changes all the time (a ticking timer, live results), and scanning it is the
  // costly part, so a scan is kept for as long as nothing changed, and never run more than ten times a
  // second. A watcher on the page (see START) sets screenDirty.
  const SCAN_MIN_GAP_MS = 100;
  const SCAN_MAX_AGE_MS = 1000;
  let screenDirty = true;
  let screenCache = { at: 0, q: null, els: [] };

  function mentiScreen() {
    const age = Date.now() - screenCache.at;
    if ((age < SCAN_MIN_GAP_MS || (!screenDirty && age < SCAN_MAX_AGE_MS)) && screenCache.els.every((el) => el.isConnected)) return screenCache;
    screenDirty = false;
    screenCache = { at: Date.now(), ...scanMentiScreen() };
    return screenCache;
  }

  // A choice can be shown with a letter or number in front of it ("A Paris").
  const choiceMatches = (shown, want) => shown === want || (shown.endsWith(want) && shown.length - want.length <= 2);

  // The element on screen for each answer, in the answers' order (so els[i] is answer i, however the page
  // lays them out), or null unless every answer has one. Exact text first, then text with a letter or
  // number in front, longest answers first so that "5" can't take the element that says "A 25". An
  // element is used once.
  function matchChoices(answers, pool) {
    const els = answers.map(() => null);
    const taken = new Set();
    const wants = answers.map((a) => textKey(a.text));
    const longestFirst = wants.map((_, i) => i).sort((a, b) => wants[b].length - wants[a].length);
    for (const exact of [true, false]) {
      for (const i of longestFirst) {
        if (els[i]) continue;
        const hit = pool.find((c) => !taken.has(c.el) && (exact ? c.key === wants[i] : choiceMatches(c.key, wants[i])));
        if (hit) { els[i] = hit.el; taken.add(hit.el); }
      }
    }
    return els.every(Boolean) ? els : null;
  }

  function scanMentiScreen() {
    let pool = [...document.querySelectorAll(TAPPABLE)]
      .filter((el) => isVisible(el) && el.textContent.length <= CHOICE_TEXT_MAX)
      .map((el) => ({ el, key: textKey(el.textContent) }))
      .filter((c) => c.key);
    // A button inside a label with the same text: take the button.
    pool = pool.filter((c) => !pool.some((o) => o !== c && o.key === c.key && c.el.contains(o.el)));

    const found = [];
    for (const q of mentiQuestions.values()) {
      const els = matchChoices(q.answers, pool);
      if (els) found.push({ q, els });
    }
    if (found.length) {
      // Two questions can share their choices (true / false, or the numbers 1 to 4). Prefer the one whose
      // text is on screen, then the one the traffic says is up, then the one whose answers are in the
      // order they're shown, then the newest. Only the text a player can see counts: the page's own
      // scripts can hold every question of the quiz.
      if (found.length > 1) {
        const pageKey = textKey(document.body?.innerText);
        const inOrder = (els) => els.every((el, i) => !i || els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const score = ({ q, els }) => (pageKey.includes(textKey(q.question)) ? 4 : 0) + (q.ids.includes(mentiActive) ? 2 : 0) + (inOrder(els) ? 1 : 0);
        found.sort((a, b) => score(b) - score(a) || b.q.seen - a.q.seen);
      }
      return found[0];
    }
    return scanMentiFallback();
  }

  // Nothing learned from the traffic matches. Take a set of radio buttons and the heading above them.
  function scanMentiFallback() {
    const none = { q: null, els: [] };
    let els = [...document.querySelectorAll('[role="radio"]')].filter(isVisible);
    if (els.length < 2) {
      els = [...document.querySelectorAll('input[type="radio"]')]
        .map((input) => input.labels?.[0] ?? input.closest("label"))
        .filter((el) => el && isVisible(el));
    }
    els = [...new Set(els)];
    if (els.length < 2 || els.some((el) => !cleanText(el.textContent))) return none;
    const heading = [...document.querySelectorAll("h1, h2, h3, legend")].find((h) => isVisible(h) && cleanText(h.textContent));
    if (!heading) return none;
    const answers = els.map((el, index) => ({ index, text: cleanText(el.textContent) }));
    return { q: { ids: [], question: cleanText(heading.textContent), answers, type: "", seen: 0 }, els };
  }

  function mentiQuestionOnScreen() {
    const { q } = mentiScreen();
    if (!q) return null;
    if (q.type && (!MENTI_QUIZ_TYPE.test(q.type) || MENTI_TYPED_ANSWER.test(q.type))) {
      return { unsupported: q.type, question: q.question, answers: [] };
    }
    return { question: q.question, answers: q.answers };
  }

  // ── READ AHASLIDES' SLIDE ─────────────────────────────────────
  // AhaSlides' audience page is a Vue app, and its store holds the slide on screen: its type, its parts,
  // and where its quiz is. That's what the page draws from, so read the question there. Every quiz slide
  // is a "pickAnswer"; slideType says which kind (none, or "imageChoice", is multiple choice). Its answer
  // controls carry data-testid attributes, which is how they're found.
  const AHA_STATUS = { rules: 2, countdown: 3, question: 4 };
  const AHA_KINDS = { imageChoice: "choice", typeAnswer: "text", correctOrder: "order", matchPairs: "match", categorise: "categorise" };
  const ahaEls = (testid) => [...document.querySelectorAll(`[data-testid="${testid}"]`)];

  // Vue puts each component on its root element as __vue__, and every component has the store.
  let ahaStoreFound = null;
  function ahaSlide() {
    if (!ahaStoreFound) {
      for (const el of document.body?.children ?? []) {
        if (el.__vue__?.$store) { ahaStoreFound = el.__vue__.$store; break; }
      }
    }
    return ahaStoreFound?.state?.slide ?? null;
  }

  // The component an element belongs to, or the nearest one above it that passes the test.
  function vueOwner(el, test) {
    while (el && !el.__vue__) el = el.parentElement;
    for (let vm = el?.__vue__; vm; vm = vm.$parent) if (test(vm)) return vm;
    return null;
  }

  // The page keeps a correct-order slide's items in the right order, and each match with its item, so
  // they're shuffled before Claude sees them: it should get them as a player does.
  function shuffled(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  // A picture's address. The slide's own picture comes in sizes; an option's is a plain address.
  function pictureUrl(image) {
    const address = typeof image === "string" ? image : image?.large ?? image?.original;
    if (!address) return null;
    try {
      const url = new URL(address, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (_) { return null; }
  }

  // Parts as the asking side wants them, keeping the option's id and its place in the slide's list.
  const numbered = (list, text, image) => list.map((item, index) => ({
    index, text: cleanText(text(item)), image: image ? pictureUrl(image(item)) : null, id: item.id, slot: item.slot,
  }));

  // The quiz question on screen, from its rules screen on (so Claude can start before the timer does).
  // key is the slide, since two slides can ask the same thing, in brackets so slide 12 isn't a part of 123.
  function ahaQuestionOnScreen() {
    const slide = ahaSlide();
    if (!slide || slide.type !== "pickAnswer" || !Object.values(AHA_STATUS).includes(slide.quizStatus)) return null;
    const kind = slide.slideType ? AHA_KINDS[slide.slideType] : "choice";
    const q = { kind, slideId: String(slide.id), key: `ahaslides-slide[${slide.id}]`, question: cleanText(slide.title),
      image: slide.image ? pictureUrl(slide.image) : null, time: Number(slide.timeToAnswer) * 1000 || 0, source: "page" };
    if (!kind) return { ...q, unsupported: slide.slideType };
    const options = (slide.SlideOptions ?? []).map((o, slot) => ({ id: o.id, slot, o }));
    try {
      if (kind === "choice") {
        q.kind = undefined;
        q.multi = !!slide.multipleChoice;
        q.answers = numbered(options.filter(({ o }) => o.title || o.image || o.imageCropped), ({ o }) => o.title, ({ o }) => o.imageCropped || o.image);
      } else if (kind === "order") {
        q.items = numbered(shuffled(options.filter(({ id }) => id)), ({ o }) => o.title);
      } else if (kind === "match") {
        const pairs = options.filter(({ o }) => (o.title || o.image) && (o.pairTitle || o.pairImage));
        q.items = numbered(pairs, ({ o }) => o.title, ({ o }) => o.imageCropped || o.image);
        q.matches = numbered(shuffled(pairs), ({ o }) => o.pairTitle, ({ o }) => o.pairImageCropped || o.pairImage);
      } else if (kind === "categorise") {
        const groups = JSON.parse(slide.matchingQuestionOptions);
        q.groups = numbered(groups, (g) => g.value);
        q.items = numbered(shuffled(groups.flatMap((g) => g.options)), (o) => o.value);
      }
    } catch (e) {
      console.debug(LOG, "Couldn't read the slide:", e.message);
      return null;
    }
    // Pictures go to Claude too, but one whose address can't be read leaves nothing to go on.
    const parts = [q.answers, q.items, q.matches, q.groups].filter(Boolean).flat();
    if ((!q.question && !q.image) || parts.some((p) => !p.text && !p.image) || (kind !== "text" && !parts.length)) {
      return { ...q, unsupported: "picture" };
    }
    return q;
  }

  function getQuestionDataFromDom() {
    if (SITE === "menti") return mentiQuestionOnScreen();
    if (SITE === "aha") return ahaQuestionOnScreen();
    const question = document.querySelector('[data-functional-selector="block-title"]')?.textContent?.trim();
    if (!question) return null;

    const answers = [];
    for (let i = 0; i < 4; i++) {
      const el = choiceTextEl(i);
      if (el) answers.push({ index: i, text: el.textContent.trim() });
    }

    if (answers.length === 0) return null;
    return { question, answers };
  }

  // Wording differs a little between the wire and the page (spacing, case, markup, entities), so
  // compare only the letters and digits.
  const textKey = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function sameText(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 12 && long.includes(short);
  }

  // ── ASK CLAUDE ────────────────────────────────────────────────
  // One request. Fast mode is a beta: it takes a header, and the beta form of the endpoint.
  async function callApi(body, fast, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(fast ? `${API_URL}?beta=true` : API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(fast ? { 'anthropic-beta': FAST_BETA } : {}),
        },
        body: JSON.stringify(fast ? { ...body, speed: 'fast' } : body),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      return { response, json };
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      const error = new Error(timedOut ? 'Claude request timed out' : e.message);
      error.timeout = timedOut;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // The reply can start with a thinking block, and with web search it has searches and their results
  // between its text. Only the text after the last of those is the answer.
  function finalText(content = []) {
    const parts = [];
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i].type === 'text') parts.unshift(content[i].text);
      else if (content[i].type !== 'thinking') break;
    }
    return parts.join('').trim();
  }

  // Every kind of question but multiple choice. A question with no kind is multiple choice: q.answers,
  // answered with one of their numbers, or with all the right ones when q.multi says several can be
  // right. The rest list their parts the same way, as { index, text }.
  //   text:       nothing to pick from; the answer is typed.
  //   order:      q.items, answered with their numbers first to last.
  //   match:      q.items and q.matches, answered with a match for each item, each match used once.
  //   categorise: q.items and q.groups, answered with a group for each item.
  // Items are numbered and the things they go with lettered, so the two can't be mixed up.
  // The question and any part can also have a picture (q.image, p.image: its address), and a part can be
  // only a picture. The list names each picture, and the pictures go along labelled the same way (see
  // pictureBlocks).
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const described = (p, label) => [p.text, p.image && `[picture ${label}]`].filter(Boolean).join(' ');
  const listed = (parts, label = (i) => i) => parts.map((p) => `${label(p.index)}: ${described(p, label(p.index))}`).join('\n');
  const asked = (q) => [q.question, q.image && "[the question's picture]"].filter(Boolean).join(' ');
  const nameOf = (p) => p.text || 'a picture';
  const lettered = (parts) => listed(parts, (i) => LETTERS[i]);
  const PAIRS_HOW = 'Reply with ONLY one line per item, its number then its letter (for example 0: B). No explanation.';

  // Where a multiple choice reply gives its letters (see KINDS.choice.read). A run of letters, each maybe
  // dressed up ("B", "(B)", "**B**"), joined by commas or "and"; a line that is only that, with
  // "Answer:" in front or not; "answer is" or "answer:" (or "answers are", "option", "choice") followed by
  // one, but not "option A" alone, which can be a mention; and a line that starts with one, followed by
  // anything but a word.
  const letterRun = (letter) => String.raw`[*_\x60(\["']*${letter}[*_\x60)\]"']*(?:\s*(?:,|;|&|\/|\band\b)\s*[*_\x60(\["']*${letter}[*_\x60)\]"']*)*`;
  const ONLY_LETTERS = new RegExp(String.raw`^(?:[*_]*answers?[*_]*\s*[:=\-–—]?[*_]*\s*)?(${letterRun('[A-Za-z]')})\s*[.!]*$`, 'i');
  const NAMED_LETTERS = new RegExp(String.raw`\b(?:[Aa]nswers?|[Oo]ptions?|[Cc]hoices?)[*_]*(?:\s+(?:is|are|would be|should be)\s*[:\-–—]?|\s*[:=\-–—])[*_]*\s*(${letterRun('[A-Z]')})(?![\p{L}\p{N}])`, 'gu');
  const LEADING_LETTERS = new RegExp(String.raw`^(${letterRun('[A-Z]')})(?=\s*(?:$|[^\p{L}\p{N}\s]))`, 'u');

  // Each item's letter, as { item index: other index }, or null unless every item got one. Pairs can be
  // written "0: B", "0 - B", "0 → B" and so on, and a later pair for the same item wins.
  function readPairs(items, others, text, oneEach) {
    const picks = {};
    for (const [, n, letter] of text.matchAll(/\b(\d+)\s*[:.)=>\-–—→]*\s*([A-Z])\b/g)) {
      const item = items.find((p) => p.index === Number(n));
      const other = others.find((p) => p.index === LETTERS.indexOf(letter));
      if (item && other) picks[item.index] = other.index;
    }
    const used = Object.values(picks);
    if (used.length !== items.length) return null;
    if (oneEach && new Set(used).size !== used.length) return null;
    return picks;
  }

  // What to ask for each kind, how to read the reply (null when it holds no usable answer), and how to
  // show the answer in the panel.
  const KINDS = {
    // The answers are lettered, not numbered: a number can be an answer itself ("3" among 1, 2, 3, 4), and
    // then its own number and its place in the list can't be told apart.
    choice: {
      ask: (q) => `${q.multi
        ? `More than one answer may be correct: pick every correct one and no wrong ones. Reply with ONLY the letters of the correct answers (${q.answers.map((a) => LETTERS[a.index]).join(', ')}), separated by commas. No explanation.`
        : `Reply with ONLY the letter of the correct answer (${q.answers.map((a) => LETTERS[a.index]).join(', ')}). No explanation, no punctuation, just the letter.`}

Question: ${asked(q)}

Answers:
${lettered(q.answers)}`,
      // With search the reply often explains itself, and its words have capitals too ("A search confirms
      // it", "Vitamin C"), so the letters are looked for where an answer is given, in this order: the last
      // line that is only letters ("B", "(B)", "**B**", "Answer: B", "B and D"); the last "answer is B"; the
      // last line that starts with them ("**B** - Paris"). Failing those, the last capital that is one of
      // the answers, leaving out an "A" or "I" that starts a sentence as a word. With several right, every
      // letter found there, or failing that every answer's letter on the last line that has any.
      read: (q, text) => {
        const index = new Map(q.answers.map((a) => [LETTERS[a.index], a.index]));
        // The answers a run of letters names, or null unless it names one (any number when several can be
        // right) and every letter in it is an answer's.
        const picks = (run) => {
          const letters = [...new Set(run.toUpperCase().match(/\b[A-Z]\b/g) ?? [])];
          return letters.length && (q.multi || letters.length === 1) && letters.every((l) => index.has(l)) ? letters.map((l) => index.get(l)) : null;
        };
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
        const found = lines.map((line) => line.match(ONLY_LETTERS)?.[1]).map((run) => run && picks(run)).find(Boolean)
          ?? [...text.matchAll(NAMED_LETTERS)].map((m) => picks(m[1])).filter(Boolean).pop()
          ?? lines.map((line) => line.match(LEADING_LETTERS)?.[1]).map((run) => run && picks(run)).find(Boolean);
        if (found) return q.multi ? found : found[0];
        const capitals = (s) => [...s.replace(/(^|[.!?]\s+)[AI](?=\s+[a-z])/g, '$1').matchAll(/\b([A-Z])\b/g)].map((m) => m[1]).filter((l) => index.has(l));
        if (q.multi) return lines.map((line) => [...new Set(capitals(line))].map((l) => index.get(l))).find((p) => p.length) ?? null;
        const last = capitals(text).pop();
        return last ? index.get(last) : null;
      },
      show: (q, pick) => [].concat(pick).map((index) => nameOf(q.answers.find((a) => a.index === index))).join(', '),
    },
    text: {
      ask: (q) => `There are no answers to pick from: the answer is typed in, and checked against the expected one. Reply with ONLY the answer, as short as it can be put (usually a word, a name or a number). No explanation, no quotes, no full stop.

Question: ${asked(q)}`,
      // The last line, without quotes or bold around it, or a full stop after it.
      read: (q, text) => {
        const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
        const answer = line.replace(/^["'“”‘’*_`]+|["'“”‘’*_`.]+$/g, '').trim();
        return answer && answer.length <= 200 ? answer : null;
      },
      show: (q, answer) => answer,
    },
    order: {
      ask: (q) => `Put these items in the correct order. Reply with ONLY their numbers in that order, first to last, separated by commas (for example 2, 0, 1). No explanation.

Question: ${asked(q)}

Items:
${listed(q.items)}`,
      // The last line that has every item's number once, so numbers in any words before it don't count.
      read: (q, text) => {
        for (const line of text.split('\n').reverse()) {
          const order = [...new Set((line.match(/\b\d+\b/g) || []).map(Number))].filter((n) => q.items.some((p) => p.index === n));
          if (order.length === q.items.length) return order;
        }
        return null;
      },
      show: (q, order) => order.map((i) => nameOf(q.items.find((p) => p.index === i))).join(' → '),
    },
    match: {
      ask: (q) => `Match each numbered item with the lettered one it goes with. Each letter goes with one item. ${PAIRS_HOW}

Question: ${asked(q)}

Items:
${listed(q.items)}

Matches:
${lettered(q.matches)}`,
      read: (q, text) => readPairs(q.items, q.matches, text, true),
      show: (q, picks) => q.items.map((p) => `${nameOf(p)} = ${nameOf(q.matches.find((m) => m.index === picks[p.index]))}`).join('; '),
    },
    categorise: {
      ask: (q) => `Sort each numbered item into the lettered group it belongs in. ${PAIRS_HOW}

Question: ${asked(q)}

Items:
${listed(q.items)}

Groups:
${lettered(q.groups)}`,
      read: (q, text) => readPairs(q.items, q.groups, text, false),
      show: (q, picks) => q.groups
        .map((g) => [g, q.items.filter((p) => picks[p.index] === g.index)])
        .filter(([, items]) => items.length)
        .map(([g, items]) => `${g.text}: ${items.map((p) => p.text).join(', ')}`)
        .join('; '),
    },
  };
  const kindOf = (q) => KINDS[q.kind ?? 'choice'];

  // The question's pictures, each after a line saying whose it is, as the list in the question names it.
  // Claude fetches them from their addresses.
  function pictureBlocks(q) {
    const labelled = [
      ...(q.image ? [["The question's picture", q.image]] : []),
      ...(q.answers ?? []).filter((p) => p.image).map((p) => [`Picture ${LETTERS[p.index]}`, p.image]),
      ...(q.items ?? []).filter((p) => p.image).map((p) => [`Picture ${p.index}`, p.image]),
      ...[q.matches, q.groups].filter(Boolean).flat().filter((p) => p.image).map((p) => [`Picture ${LETTERS[p.index]}`, p.image]),
    ];
    return labelled.flatMap(([label, url]) => [{ type: 'text', text: `${label}:` }, { type: 'image', source: { type: 'url', url } }]);
  }

  // Some hosts won't hand their pictures to Claude. Then the page fetches them and sends them along as
  // data, which works where the host lets other sites read its pictures.
  async function inlinePictures(content) {
    try {
      return await Promise.all(content.map(async (block) => {
        if (block.type !== 'image') return block;
        const response = await fetch(block.source.url);
        const blob = await response.blob();
        const type = blob.type.replace('image/jpg', 'image/jpeg');
        if (!response.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) throw new Error(`${response.status} ${type || 'no type'}`);
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { type: 'image', source: { type: 'base64', media_type: type, data } };
      }));
    } catch (e) {
      const error = new Error(`Couldn't send the pictures to Claude (${e.message})`);
      error.fatal = true; // trying again won't load them either
      throw error;
    }
  }

  // Claude's answer: an answer's number for multiple choice, otherwise whatever that kind's read gives.
  // Null when the reply has no usable answer.
  async function askClaude(data, { search = prefs.webSearch } = {}) {
    if (!apiKey) {
      const error = new Error('No API key — paste it in the panel');
      error.fatal = true;
      throw error;
    }
    let fast = prefs.fast && fastModel();
    const prompt = `You are answering a quiz question. ${search ? SEARCH_LEAD : ''}${kindOf(data).ask(data)}`;
    // Pictures go first, then the question that names them.
    const pictures = pictureBlocks(data);
    let inlined = false;

    const body = {
      model: prefs.model,
      max_tokens: TOKENS_BY_EFFORT[prefs.effort] + (search ? SEARCH_EXTRA_TOKENS : 0),
      messages: [{ role: 'user', content: pictures.length ? [...pictures, { type: 'text', text: prompt }] : prompt }],
      output_config: { effort: prefs.effort },
    };
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: prefs.maxSearches }];
    const timeoutMs = search ? prefs.searchTimeout : prefs.timeout;

    let json;
    for (let step = 0; ; step++) {
      let { response, json: reply } = await callApi(body, fast, timeoutMs);
      // Fast mode has its own rate limit, and not every account has it. Use normal speed instead.
      if (fast && (response.status === 429 || (response.status === 400 && /speed|fast/i.test(reply.error?.message ?? '')))) {
        console.log(LOG, 'Fast mode was refused, using normal speed:', reply.error?.message ?? `HTTP ${response.status}`);
        fast = false;
        ({ response, json: reply } = await callApi(body, false, timeoutMs));
      }
      if (response.status === 400 && pictures.length && !inlined && /image|url|download|fetch|media/i.test(reply.error?.message ?? '')) {
        console.log(LOG, "Claude couldn't fetch the pictures, sending them from the page:", reply.error?.message);
        inlined = true;
        body.messages[0] = { role: 'user', content: await inlinePictures(body.messages[0].content) };
        ({ response, json: reply } = await callApi(body, fast, timeoutMs));
      }
      if (response.status === 401) {
        const error = new Error('Invalid API key — paste a new one in the panel');
        error.fatal = true;
        throw error;
      }
      if (!response.ok) throw new Error(reply.error?.message || `HTTP ${response.status}`);

      json = reply;
      // A long search turn can pause. Hand back what it has so far and it carries on.
      if (json.stop_reason !== 'pause_turn' || step >= MAX_CONTINUATIONS) break;
      body.messages = [...body.messages, { role: 'assistant', content: json.content }];
    }

    const text = finalText(json.content);
    if (!text) {
      if (json.stop_reason === 'refusal') throw new Error('Claude declined this question');
      if (json.stop_reason === 'max_tokens') throw new Error('Claude ran out of tokens');
      if (json.stop_reason === 'pause_turn') throw new Error('Claude was still searching');
      return null;
    }
    return kindOf(data).read(data, text);
  }

  // One retry, since a single hiccup shouldn't cost the question. A bad key won't fix itself,
  // and a request that already timed out would only cost the same time again.
  async function askWithRetry(data, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await askClaude(data, options);
        if (answer !== null || attempt >= 1) return answer;
      } catch (e) {
        if (e.fatal || e.timeout || attempt >= 1) throw e;
      }
      await sleep(700);
    }
  }

  // ── ASKING, AND ASKING AHEAD ──────────────────────────────────
  // With web search on, the searched answer is the one wanted (it's what gets a recent or local fact
  // right), but a search can take several seconds, so the same question is also asked without searching.
  // If the search is still out SEARCH_GRACE_MS after the question went live, the quick answer is used.
  // track() follows a request without ever rejecting.
  function track(promise) {
    const t = { done: false, value: undefined, error: undefined };
    t.promise = promise.then((value) => { t.done = true; t.value = value; }, (error) => { t.done = true; t.error = error; });
    return t;
  }

  // Asked ahead, there's no quick answer yet (see addQuick).
  function startAsk(q, { ahead = false } = {}) {
    const entry = { deep: track(askWithRetry(q, { search: prefs.webSearch })), quick: null, search: prefs.webSearch };
    return ahead ? entry : addQuick(entry, q);
  }

  // The quick answer is only asked for once the question is up and the search isn't back: with minutes
  // to go the search nearly always wins, and the quick answer would be paid for and thrown away.
  function addQuick(entry, q) {
    if (entry.search && !entry.quick && !usable(entry.deep)) entry.quick = track(askWithRetry(q, { search: false }));
    return entry;
  }

  const usable = (t) => !!t && t.done && !t.error && t.value !== null;
  const failed = (t) => !!t && t.done && !usable(t);
  // An answer is in hand: the searched one, or the quick one once the searched one has given up.
  const ready = (entry) => usable(entry.deep) || (entry.deep.done && usable(entry.quick));

  // Whether the question has gone live: its buttons are on screen, enabled or not (Kahoot shows them a
  // moment before it takes answers, and some never look enabled), or on AhaSlides its slide is on the
  // question screen. The first time that's seen is taken as when its timer started, r.liveAt, and both
  // the grace for a slow search and the answer delay count from then. Every wait for the question
  // checks it, so whichever is running when it goes live notes the time.
  function seenLive(q, r) {
    if (!r.liveAt && (SITE === 'aha' ? ahaLive(q) : locateButton(q, 0) >= 0)) r.liveAt = Date.now();
    return !!r.liveAt;
  }

  // The answer to a started question: the searched one when it comes, else the quick one once the question
  // has been live for the grace period, or once the search has failed. Throws what the attempts threw.
  // When the quick answer is used, r.withoutSearch says why.
  async function answerBy(entry, q, r) {
    const { deep, quick } = entry;
    const grace = q.time ? Math.max(0, Math.min(SEARCH_GRACE_MS, q.time - prefs.margin)) : SEARCH_GRACE_MS;
    while (!r.cancelled) {
      seenLive(q, r);
      if (usable(deep)) return deep.value;
      if (deep.done && (!quick || quick.done)) {
        if (usable(quick)) {
          const why = deep.error?.message ?? 'no usable answer';
          console.warn(LOG, 'The search failed, using the quick answer:', why);
          r.withoutSearch = `failed: ${why}`;
          return quick.value;
        }
        if (deep.error || quick?.error) throw deep.error ?? quick.error;
        return null;
      }
      if (usable(quick) && r.liveAt && Date.now() - r.liveAt >= grace) {
        console.log(LOG, 'The search is taking long, using the quick answer');
        r.withoutSearch = 'too slow';
        return quick.value;
      }
      await sleep(40);
    }
    return null;
  }

  // ── ANSWER AHEAD ──────────────────────────────────────────────
  // Menti hands over the whole quiz when it loads, so Claude can work through the questions while the
  // players are still waiting, and each answer is there by the time its question comes up. That takes
  // Claude's thinking out of the time the question is on screen. Answers are kept by question, choices
  // and settings, so changing the model asks again.
  const PREFETCH_PARALLEL = 2;
  // The most questions asked ahead under the same settings.
  const PREFETCH_MAX = 60;
  // A question whose search keeps failing ahead is left until it comes up.
  const PREFETCH_TRIES = 3;
  // After a failure (a rate limit, a dropped connection) nothing more is asked ahead for this long,
  // doubling with each failure in a row.
  const PREFETCH_RETRY_MS = 2000;
  const PREFETCH_RETRY_MAX_MS = 60000;
  const answerCache = new Map(); // key -> { deep, quick, search, tries }
  let prefetching = 0;
  let prefetchTimer = 0;
  let prefetchHalted = false; // the key was refused: stop until there's a new one
  let prefetchRetryAt = 0;
  let prefetchBackoff = PREFETCH_RETRY_MS;

  // The settings an answer was asked under, then the question and its choices.
  const settingsKey = () => [prefs.model, prefs.effort, prefs.webSearch && prefs.maxSearches, prefs.fast && fastModel()].join("/");
  const cacheKey = (q) => [settingsKey(), textKey(q.question), q.answers.map((a) => textKey(a.text)).join("|")].join("/");

  // Asks once per question and settings, whether the question is up already or still to come. A search
  // that failed is asked again, keeping a quick answer already in hand or on its way.
  function askCached(q, { ahead = false } = {}) {
    const key = cacheKey(q);
    let entry = answerCache.get(key);
    if (!entry || failed(entry.deep)) {
      const quick = entry?.quick && !failed(entry.quick) ? entry.quick : null;
      entry = { ...startAsk(q, { ahead: true }), quick, tries: (entry?.tries ?? 0) + 1 };
      answerCache.set(key, entry);
    }
    return ahead ? entry : addQuick(entry, q);
  }

  // Only the questions known to be quiz questions with choices; a poll has no right answer, and a
  // question of unknown type is left until it's on screen.
  const prefetchable = (q) => MENTI_QUIZ_TYPE.test(q.type) && !MENTI_TYPED_ANSWER.test(q.type);

  function schedulePrefetch(delay = 50) {
    if (SITE !== "menti" || prefetchTimer) return;
    prefetchTimer = setTimeout(() => { prefetchTimer = 0; pumpPrefetch(); }, delay);
  }

  // Keeps a couple of questions going at a time, from the one that's up on: the ones before it have been
  // played. Until the traffic names a question that's up, every question.
  function pumpPrefetch() {
    if (SITE !== "menti" || !prefs.prefetch || !apiKey || prefetchHalted) return;
    const wait = prefetchRetryAt - Date.now();
    if (wait > 0) { schedulePrefetch(wait); return; }
    const known = [...mentiQuestions.values()];
    const queue = known.slice(Math.max(0, known.findIndex((q) => q.ids.includes(mentiActive)))).filter(prefetchable);
    const settings = settingsKey() + "/";
    let asked = [...answerCache.keys()].filter((key) => key.startsWith(settings)).length;
    for (const q of queue) {
      if (prefetching >= PREFETCH_PARALLEL) break;
      const data = { question: q.question, answers: q.answers, source: "wire" };
      const entry = answerCache.get(cacheKey(data));
      if (entry && (!failed(entry.deep) || entry.tries >= PREFETCH_TRIES)) continue;
      if (!entry && asked++ >= PREFETCH_MAX) break;
      prefetching++;
      const started = Date.now();
      // Only a finished answer starts the next one at once. After a failure the next waits, longer each
      // time, so a failing connection or a rate limit can't loop.
      const { deep } = askCached(data, { ahead: true });
      deep.promise.then(() => {
        prefetching--;
        if (usable(deep)) {
          prefetchBackoff = PREFETCH_RETRY_MS;
          console.log(LOG, `Asked ahead (${((Date.now() - started) / 1000).toFixed(1)}s):`, q.question, "→", kindOf(data).show(data, deep.value));
          pumpPrefetch();
        } else if (deep.error?.fatal) {
          prefetchHalted = true;
        } else {
          console.debug(LOG, `Couldn't ask ahead, trying again in ${prefetchBackoff / 1000}s:`, deep.error?.message ?? "no usable answer");
          prefetchRetryAt = Date.now() + prefetchBackoff;
          schedulePrefetch(prefetchBackoff);
          prefetchBackoff = Math.min(prefetchBackoff * 2, PREFETCH_RETRY_MAX_MS);
        }
      });
    }
  }

  // ── FIND THE ANSWER BUTTON ────────────────────────────────────
  // Which button holds this answer? Kahoot can shuffle the buttons for a player, so go by the text on
  // the page when it's there, else by position. -1 when the buttons aren't there yet, or when the page
  // shows other answers (an older question's screen).
  function locateButton(q, index) {
    if (SITE === "menti") {
      // The buttons are already matched to the answers, in order, so only check the page still shows
      // this question's answers.
      const { q: shown, els } = mentiScreen();
      const same = shown && shown.answers.length === q.answers.length && shown.answers.every((a, i) => textKey(a.text) === textKey(q.answers[i].text));
      return same && els[index] ? index : -1;
    }
    const text = q.answers.find((a) => a.index === index)?.text;
    let choicesShown = false;
    if (text) {
      const want = textKey(text);
      for (let i = 0; i < 8; i++) {
        const el = choiceTextEl(i);
        if (!el) break;
        choicesShown = true;
        if (textKey(el.textContent) === want && buttonFor(i)) return i;
      }
    }
    if (choicesShown) return -1;
    return buttonFor(index) ? index : -1;
  }

  // Wait for the button, and for Kahoot to enable it: it shows the buttons a moment before it takes
  // answers. That's also the sign the question is live. If it never enables, return the button anyway.
  async function waitForButton(q, index, r) {
    const startedWaiting = Date.now();
    const deadline = startedWaiting + BUTTON_WAIT_MS;
    let found = -1;
    let reported = false;
    while (!r.cancelled && Date.now() < deadline) {
      seenLive(q, r);
      found = locateButton(q, index);
      if (found >= 0) {
        r.sawButtons = true;
        const disabled = isDisabled(buttonFor(found));
        if (!reported) {
          reported = true;
          console.log(LOG, `Answer button ${found} is on screen (${disabled ? 'disabled' : 'enabled'}) after ${Date.now() - startedWaiting}ms`);
        }
        if (!disabled) return found;
      }
      await sleep(100);
    }
    if (!r.cancelled) console.log(LOG, found >= 0 ? `Answer button ${found} never got enabled` : "Never found the answer button");
    return found;
  }

  // ── SEND THE ANSWER ───────────────────────────────────────────
  // Answer the way Kahoot's own client does: a message on /service/controller over the WebSocket.
  // There's no socket to send on when Kahoot is on HTTP long-polling, or before it has connected.
  const canSendOverWs = () => !!activeWs && activeWs.readyState === 1 && !!gameId && !!clientId;

  // Returns 'sent', 'nosocket' (nothing to send on), or 'missed' (the question screen was already gone).
  function submitAnswer(index, button) {
    if (!buttonFor(button)) return 'missed';
    if (!canSendOverWs()) return 'nosocket';
    const questionIndex = wireIndex ?? roundsStarted - 1;
    const packet = [{
      id: String(++msgId),
      channel: '/service/controller',
      data: {
        gameid: gameId, type: 'message', host: 'kahoot.it', id: answerDataId,
        content: JSON.stringify({ type: 'quiz', choice: index, questionIndex, meta: { lag: Math.floor(10 + Math.random() * 40) } })
      },
      clientId, ext: {}
    }];
    activeWs.send(JSON.stringify(packet));
    console.log(LOG, `Answer ${index} sent over the WebSocket (question ${questionIndex}, ${wireIndex === null ? 'counted' : 'from Kahoot'})`);
    return 'sent';
  }

  // Mentimeter: tap the answer like a player would. Some screens take the answer with that tap, others
  // pick it and want a Submit button pressed after, so press that too when one shows up.
  // Returns 'tapped', or 'missed' (the question screen was already gone).
  const SUBMIT_TEXT = /^(submit|send|vote|answer|skicka|rösta|svara|absenden|senden|abstimmen|envoyer|valider|voter|enviar|votar|invia|vota|verzenden|stemmen|wyślij|odeslat|lähetä|send inn|indsend)\b/i;

  function findSubmit(choice) {
    const choices = mentiScreen().els;
    const inForm = choice.closest('form')?.querySelector('button[type="submit"], input[type="submit"]');
    if (inForm && isVisible(inForm)) return inForm;
    return [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => isVisible(el) && !choices.some((c) => c === el || c.contains(el) || el.contains(c)) && SUBMIT_TEXT.test(cleanText(el.textContent)));
  }

  async function tapAnswer(button) {
    const el = buttonFor(button);
    if (!el) return 'missed';
    el.click();
    console.log(LOG, `Tapped answer ${button}:`, cleanText(el.textContent));
    for (const deadline = Date.now() + 1500; Date.now() < deadline; await sleep(100)) {
      if (!el.isConnected) break; // the screen moved on: the tap was the answer
      const submit = findSubmit(el);
      if (submit && !isDisabled(submit)) {
        submit.click();
        console.log(LOG, 'Pressed', JSON.stringify(cleanText(submit.textContent)));
        break;
      }
    }
    return 'tapped';
  }

  // AhaSlides: answer like a player, then press Submit. Options are tapped and a short answer typed in.
  // A match or a group is picked from the list that opens when its item is tapped. Items to put in order
  // are dragged, and a drag can't be faked reliably, so their order goes to the list's own component
  // instead, the way a finished drag hands it over.
  const ahaLive = (q) => {
    const slide = ahaSlide();
    return !!slide && String(slide.id) === q.slideId && slide.quizStatus === AHA_STATUS.question;
  };
  const ahaOption = (id) => ahaEls('audience-quiz-option').find((el) => el.dataset.id === String(id)) ?? null;
  const ahaDisabled = (el) => isDisabled(el) || !!el.closest('.aha-option--disabled, .match-pair-content--disabled');
  const textIn = (el, selector) => textKey(el.querySelector(selector)?.textContent);

  // Polls until get() gives something, or the time is up.
  async function waitFor(get, ms) {
    for (const deadline = Date.now() + ms; ; await sleep(50)) {
      const value = get();
      if (value || Date.now() >= deadline) return value;
    }
  }

  // Each kind's controls, once they're on screen and take input; null until then. A match-pairs slide
  // has an item on screen for every option, in the slide's order, so its items are found by place.
  const AHA_CONTROLS = {
    choice: (q, pick) => {
      const els = [].concat(pick).map((index) => ahaOption(q.answers.find((a) => a.index === index).id));
      return els.every((el) => el && !ahaDisabled(el)) ? els : null;
    },
    text: () => ahaEls('audience-quiz-type-answer-input').find((el) => !ahaDisabled(el)) ?? null,
    order: () => {
      const list = ahaEls('audience-quiz-correct-order-draggable-list')[0];
      const vm = list && vueOwner(list, (c) => Array.isArray(c.correctOrderOptions) && typeof c.sortOption === 'function');
      return vm && !vm.isDisableDrag ? vm : null;
    },
    match: (q) => {
      const els = ahaEls('audience-quiz-match-pairs-option-item');
      return els.length > Math.max(...q.items.map((p) => p.slot)) && !ahaDisabled(els[0]) ? els : null;
    },
    categorise: (q) => {
      const els = ahaEls('audience-quiz-categorise-option-item');
      return els.length >= q.items.length && !ahaDisabled(els[0]) ? els : null;
    },
  };

  // Wait for this question's controls: they come up when its timer starts. For multiple choice, returns
  // where the (first) pick is on screen, for the highlight; otherwise null. -1 if they never come up, or
  // the slide has moved on to its results or another slide.
  async function waitForAhaControls(q, answer, r) {
    for (const deadline = Date.now() + BUTTON_WAIT_MS; !r.cancelled && Date.now() < deadline; await sleep(100)) {
      const slide = ahaSlide();
      if (String(slide?.id) !== q.slideId || slide.quizStatus > AHA_STATUS.question) break;
      seenLive(q, r);
      if (!ahaLive(q)) continue;
      const controls = AHA_CONTROLS[q.kind ?? 'choice'](q, answer);
      if (!controls) continue;
      console.log(LOG, `Answer controls are up after ${Date.now() - r.startedAt}ms`);
      return q.kind ? null : ahaEls('audience-quiz-option').indexOf(controls[0]);
    }
    if (!r.cancelled) console.log(LOG, 'The answer controls never came up');
    return -1;
  }

  // Tap an item, wait for the list of matches or groups it opens, and tap the one wanted there. Picking
  // one closes the list.
  async function pickFromList(q, r, item, listTestid, wanted) {
    if (!item || r.cancelled || !ahaLive(q)) return false;
    item.click();
    const list = await waitFor(() => { const els = ahaEls(listTestid); return els.length ? els : null; }, 2000);
    const choice = list?.find(wanted);
    if (!choice) {
      document.querySelector('[data-testid^="audience-quiz-"][data-testid$="-overlay"]')?.click();
      return false;
    }
    choice.click();
    await waitFor(() => !ahaEls(listTestid).length, 2000);
    return true;
  }

  // Each kind's way in. True when it's all entered.
  const AHA_ENTER = {
    // Taps one at a time, since the page works out each tap's result from the one before. With several
    // right, an option that's picked but shouldn't be is tapped off.
    choice: async (q, pick) => {
      const want = AHA_CONTROLS.choice(q, pick);
      if (!want) return false;
      for (const el of ahaEls('audience-quiz-option')) {
        const picked = el.classList.contains('aha-option--selected');
        if (want.includes(el) ? picked : !(picked && q.multi)) continue;
        el.click();
        await sleep(150);
      }
      return true;
    },
    text: async (q, answer) => {
      const input = AHA_CONTROLS.text();
      if (!input) return false;
      input.value = answer;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    order: async (q, order) => {
      const vm = AHA_CONTROLS.order();
      if (!vm) return false;
      const byId = new Map(vm.correctOrderOptions.map((o) => [String(o.id), o]));
      const items = order.map((index) => byId.get(String(q.items.find((p) => p.index === index).id)));
      if (items.length !== byId.size || items.some((o) => !o)) return false;
      vm.correctOrderOptions = items;
      vm.sortOption();
      return true;
    },
    // The list a match is picked from belongs to a component that holds its options in the same order,
    // so the wanted match is found by its option, which works for a picture as well as for text.
    match: async (q, picks, r) => {
      for (const item of q.items) {
        const match = q.matches.find((m) => m.index === picks[item.index]);
        const slot = AHA_CONTROLS.match(q)?.[item.slot];
        const wanted = (el, i) => {
          const list = vueOwner(el, (c) => Array.isArray(c.matchPairsOption))?.matchPairsOption;
          return list ? String(list[i]?.id) === String(match.id) : textIn(el, '.pair-title-text') === textKey(match.text);
        };
        if (!(await pickFromList(q, r, slot, 'audience-quiz-match-pairs-pair-item', wanted))) return false;
      }
      return true;
    },
    // The items are on screen in their own shuffled order, so they're found by their text. Two items can
    // read the same; each is used once.
    categorise: async (q, picks, r) => {
      const used = new Set();
      for (const item of q.items) {
        const els = AHA_CONTROLS.categorise(q) ?? [];
        const at = els.findIndex((el, i) => !used.has(i) && textIn(el, '.pair-left-text') === textKey(item.text));
        used.add(at);
        const want = textKey(q.groups.find((g) => g.index === picks[item.index]).text);
        if (!(await pickFromList(q, r, els[at], 'audience-quiz-categorise-category-item', (el) => textIn(el, '.pair-title-text') === want))) return false;
      }
      return true;
    },
  };

  // Returns 'entered', 'missed' (the question screen was already gone) or 'stuck' (some of it couldn't be
  // entered, or Submit never came on).
  async function enterAhaAnswer(q, answer, r) {
    if (!ahaLive(q)) return 'missed';
    const entered = await AHA_ENTER[q.kind ?? 'choice'](q, answer, r);
    if (!ahaLive(q)) return 'missed';
    if (!entered) return 'stuck';
    const submit = await waitFor(() => ahaEls('audience-quiz-submit-button').find((el) => !isDisabled(el)), 3000);
    if (!submit) return ahaLive(q) ? 'stuck' : 'missed';
    submit.click();
    console.log(LOG, 'Entered the answer and pressed Submit');
    return 'entered';
  }

  // ── ANSWER HIGHLIGHT ──────────────────────────────────────────
  // A soft outline over the answer Claude picked. Drawn over the page, not in it (in the panel's
  // shadow root), so Kahoot re-rendering or restyling can't touch it, and it follows the button until
  // the question screen goes away.
  let mark = null; // { chosen, el }

  function showMark(chosen) {
    if (mark?.chosen === chosen || !root) return;
    clearMark();
    const el = document.createElement('div');
    el.className = 'ring';
    root.appendChild(el);
    const own = mark = { chosen, el };
    requestAnimationFrame(() => placeMark(own));
  }

  function clearMark() {
    mark?.el.remove();
    mark = null;
  }

  // One animation-frame loop per mark; it ends when its mark is replaced or cleared.
  function placeMark(own) {
    if (mark !== own) return;
    const btn = buttonFor(own.chosen);
    if (!btn) { clearMark(); return; } // the question screen is gone
    const rect = btn.getBoundingClientRect();
    own.el.style.left = `${rect.left}px`;
    own.el.style.top = `${rect.top}px`;
    own.el.style.width = `${rect.width}px`;
    own.el.style.height = `${rect.height}px`;
    requestAnimationFrame(() => placeMark(own));
  }

  // Show or hide the highlight to match the switch and the question being handled.
  function syncMark() {
    const pick = round && !round.cancelled ? round.pick : undefined;
    if (prefs.highlight && pick !== undefined) showMark(pick);
    else clearMark();
  }

  // ── UI ────────────────────────────────────────────────────────
  // The panel lives in a shadow root, so Kahoot's own styles can't reach in and restyle it (a page
  // rule squeezing the key box is what that prevents), and nothing here leaks out to the page. It is
  // made for a phone first: a one-line bar that keeps the answer in view with the settings folded
  // away, big tap targets, and 16px text in the boxes (anything smaller makes iOS zoom in).
  let root = null;
  const $ = (id) => root?.getElementById(id) ?? null;

  // Kahoot's top bar has a badge ("Quiz") on the question screens. That's the panel's button while it's
  // there; the ⚡ button is for everywhere else, like the lobby. Kahoot's class names are generated, so
  // find it by the label's data attribute, and take the label's parent, which holds the icon as well.
  const BADGE_LABEL = '[data-functional-selector^="question-type-heading"]';
  const findBadge = () => document.querySelector(BADGE_LABEL)?.parentElement ?? null;
  let badge = null;

  const SWITCHES = [
    { name: 'autoAnswer', label: 'Auto-answer', hint: "Sends Claude's answer for you" },
    { name: 'highlight', label: 'Highlight answer', hint: 'A soft outline on the pick' },
    { name: 'webSearch', label: 'Web search', hint: 'Right on recent and local facts. About 4 cents a question' },
    { name: 'fast', label: 'Fast mode', hint: 'Opus 5.5 only, at twice the price' },
    { name: 'prefetch', label: 'Answer ahead', hint: 'Menti: asks the whole quiz before it starts' },
  ];

  // The Advanced section, folded away until asked for. `scale` turns the saved value into what's shown
  // (milliseconds into seconds). A field with options in PREFS is a menu, the rest are numbers. The two
  // delays share one row, with a two-thumb slider (delayRow).
  const ADVANCED = [
    { name: 'delayMin', label: 'Shortest answer delay', unit: 's', scale: 1000, slider: true },
    { name: 'delayMax', label: 'Longest answer delay', unit: 's', scale: 1000, slider: true },
    { name: 'margin', label: 'Timer margin', hint: "Always leave this much of the question's timer", unit: 's', scale: 1000, step: 0.5 },
    { name: 'effort', label: 'Thinking effort', hint: 'Higher is slower, and better on hard questions' },
    { name: 'maxSearches', label: 'Web searches', hint: 'The most it may run per question', unit: '', scale: 1, step: 1 },
    { name: 'timeout', label: 'Request timeout', hint: 'Give up on Claude after this long', unit: 's', scale: 1000, step: 1 },
    { name: 'searchTimeout', label: 'Timeout with search', hint: 'Searching takes longer', unit: 's', scale: 1000, step: 1 },
  ];
  const ADVANCED_SWITCHES = [
    { name: 'trace', label: 'Debug log', hint: "Prints the game's messages in the browser console" },
  ];
  let advancedOpen = false;

  const PANEL_CSS = `
    *, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    [hidden] { display: none !important; }
    button, input, select { font: inherit; color: inherit; margin: 0; }

    .ring {
      position: fixed; z-index: 1; pointer-events: none; border-radius: 12px;
      border: 2px solid rgba(63, 185, 80, .45); background: rgba(63, 185, 80, .12);
    }

    .panel, .fab {
      position: fixed; z-index: 2;
      top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right));
      font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e2e8f0;
    }
    .panel {
      width: min(360px, calc(100vw - 16px));
      max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px);
      display: flex; flex-direction: column; overflow: hidden;
      background: #0f1117; border: 1px solid #30363d; border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, .6);
    }
    .fab {
      width: 44px; height: 44px; border: 1px solid rgba(88, 166, 255, .35); border-radius: 50%; padding: 0;
      background: rgba(88, 166, 255, .15); color: rgba(88, 166, 255, .8); font-size: 20px; font-weight: 700; cursor: pointer;
    }
    .fab.ghost { opacity: 0; } /* still takes taps */

    .bar { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 6px 6px 6px 12px; }
    .logo { flex: none; color: #58a6ff; font-size: 18px; }
    .readout { flex: 1; min-width: 0; }
    .status {
      color: #8b949e; font-size: 12px; overflow: hidden; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .answer-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .answer { min-width: 0; color: #3fb950; font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
    .picks { display: flex; flex: none; gap: 4px; }
    .picks:empty { display: none; }
    .pick {
      display: grid; place-items: center; min-width: 26px; height: 26px; padding: 0 6px; border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, .25); background: #30363d; color: #e2e8f0; font-size: 15px; font-weight: 800;
    }
    .icon {
      flex: none; display: grid; place-items: center; width: 44px; height: 44px; padding: 0;
      border: 0; border-radius: 10px; background: transparent; color: #8b949e; font-size: 20px; cursor: pointer;
    }
    .icon:active, .icon[aria-expanded="true"] { background: #1c2330; color: #e2e8f0; }

    .settings { overflow-y: auto; overscroll-behavior: contain; padding: 0 12px 8px; border-top: 1px solid #21262d; }
    .field-head, .field-row, .row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px;
    }
    .field-head { min-height: 44px; padding-top: 4px; }
    .key-tools { display: flex; align-items: center; }
    .key-state { color: #f85149; font-size: 12px; }
    .key-state.ok { color: #3fb950; }
    .link { padding: 10px 8px; border: 0; background: none; color: #58a6ff; font-size: 13px; cursor: pointer; }
    .editor { display: flex; gap: 8px; padding-bottom: 10px; }
    input, select {
      height: 44px; padding: 0 10px; border: 1px solid #30363d; border-radius: 8px;
      background: #161b22; color: #e2e8f0; font-size: 16px;
    }
    input { flex: 1; min-width: 0; }
    select { min-width: 0; max-width: 55%; }
    .save {
      flex: none; height: 44px; padding: 0 18px; border: 0; border-radius: 8px;
      background: #238636; color: #fff; font-weight: 600; cursor: pointer;
    }
    .row {
      width: 100%; padding: 6px 0; border: 0; border-top: 1px solid #21262d; background: none;
      text-align: left; cursor: pointer;
    }
    .text { display: flex; flex-direction: column; min-width: 0; }
    .hint { color: #8b949e; font-size: 12px; }
    .row-field {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      min-height: 52px; padding: 6px 0; border-top: 1px solid #21262d;
    }
    .row-field select { flex: none; width: 112px; max-width: none; }
    .num-wrap { display: flex; align-items: center; gap: 6px; flex: none; }
    .num { flex: none; width: 88px; text-align: right; }
    .num.short { width: 64px; padding: 0 6px; text-align: center; }

    .range-field { flex-direction: column; align-items: stretch; gap: 0; padding-bottom: 2px; }
    .range-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .dual {
      position: relative; height: 44px; cursor: pointer; touch-action: pan-y;
      user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    }
    .dual-rail, .dual-ticks { position: absolute; left: 14px; right: 14px; }
    .dual-rail { top: 0; bottom: 0; }
    .dual-track {
      position: absolute; left: 0; right: 0; top: 50%; height: 6px; margin-top: -3px;
      border-radius: 3px; background: #30363d;
    }
    .dual-fill { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: #238636; }
    .dual-thumb {
      position: absolute; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
      background: #e2e8f0; box-shadow: 0 1px 4px rgba(0, 0, 0, .5); outline: none; transition: box-shadow .1s;
    }
    .dual-thumb.active { z-index: 1; box-shadow: 0 0 0 9px rgba(63, 185, 80, .3); }
    .dual-thumb:focus-visible { box-shadow: 0 0 0 3px #58a6ff; }
    .dual-scale { position: relative; height: 16px; margin-top: -6px; color: #8b949e; font-size: 11px; }
    .dual-ticks span { position: absolute; top: 0; transform: translateX(-50%); }
    .unit { min-width: 8px; color: #8b949e; font-size: 13px; }
    .chev { flex: none; color: #8b949e; font-size: 16px; }
    .reset {
      width: 100%; height: 44px; margin: 8px 0 4px; border: 1px solid #30363d; border-radius: 8px;
      background: none; color: #8b949e; cursor: pointer;
    }
    .track {
      position: relative; flex: none; width: 48px; height: 28px; border-radius: 14px;
      background: #30363d; transition: background .15s;
    }
    .track::after {
      content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
      border-radius: 50%; background: #e2e8f0; transition: transform .15s;
    }
    .row[aria-checked="true"] .track { background: #238636; }
    .row[aria-checked="true"] .track::after { transform: translateX(20px); }
    .row[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
  `;

  function setStatus(text, color) {
    const el = $('kahoot-status');
    if (el) { el.textContent = text; el.style.color = color || ''; }
  }

  // A new answer clears the badges, which belong to the one it replaces.
  function setAnswer(text, color) {
    const el = $('kahoot-answer');
    if (el) { el.textContent = text; el.style.color = color || ''; }
    setPicks([]);
  }

  // A badge for each picked answer button, with its number on screen in its color, so it can be found
  // at a glance (a Kahoot player's phone shows only the colors).
  function setPicks(positions) {
    const box = $('kahoot-picks');
    if (!box) return;
    box.replaceChildren(...positions.map((position) => {
      const badge = document.createElement('span');
      badge.className = 'pick';
      badge.textContent = String(screenPlace(position) + 1);
      const color = buttonColor(buttonFor(position));
      if (color) {
        badge.style.background = color.css;
        badge.style.color = color.light ? '#111' : '#fff';
      }
      return badge;
    }));
  }

  // The color a button shows: its own background, or the first one set inside it. A see-through color
  // is taken as it looks over a white page.
  function buttonColor(el) {
    if (!el) return null;
    for (const node of [el, ...el.querySelectorAll('*')].slice(0, 30)) {
      const parts = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (!parts || parts.length < 3) continue;
      const [r, g, b, a = 1] = parts.map(Number);
      if (a < 0.05) continue;
      const [R, G, B] = [r, g, b].map((v) => Math.round(v * a + 255 * (1 - a)));
      return { css: `rgb(${R}, ${G}, ${B})`, light: 0.299 * R + 0.587 * G + 0.114 * B > 160 };
    }
    return null;
  }

  // With no key the settings stay open, since there's nothing to do until one is pasted.
  function uiState() {
    if (prefs.ui === 'hidden' || prefs.ui === 'off') return prefs.ui;
    return !apiKey || prefs.ui === 'open' ? 'open' : 'compact';
  }

  const panelShown = () => uiState() === 'compact' || uiState() === 'open';

  function renderUi() {
    if (!root) return;
    const state = uiState();
    $('kahoot-fab').hidden = panelShown() || !!badge;
    $('kahoot-fab').classList.toggle('ghost', state === 'off');
    $('kahoot-panel').hidden = !panelShown();
    $('kahoot-settings').hidden = state !== 'open';
    $('kahoot-toggle').setAttribute('aria-expanded', String(state === 'open'));
    styleBadge();
    placePanel(); // so it opens where it belongs, not a tick later
  }

  // The badge looks tappable, and lit while the panel is up. Hidden completely, it looks untouched (a
  // tap still brings the panel back).
  function styleBadge() {
    if (!badge) return;
    badge.style.cursor = uiState() === 'off' ? '' : 'pointer';
    badge.style.outline = panelShown() ? '2px solid rgba(88, 166, 255, .75)' : '';
    badge.style.outlineOffset = '2px';
  }

  // Keep the panel just under the badge, so it never covers the button that closes it.
  function placePanel() {
    const panel = $('kahoot-panel');
    if (!panel) return;
    if (!badge) {
      panel.style.top = panel.style.maxHeight = '';
      return;
    }
    const top = Math.max(8, Math.round(badge.getBoundingClientRect().bottom) + 8);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
    panel.style.maxHeight = `calc(100dvh - ${top + 8}px)`; // ignored where dvh isn't known
  }

  // Kahoot re-renders its top bar between screens, so look again each time round rather than hold on
  // to one element.
  function syncLauncher() {
    if (!root) return;
    const found = findBadge();
    if (found !== badge) {
      if (badge) badge.style.cursor = badge.style.outline = badge.style.outlineOffset = '';
      badge = found;
      renderUi();
    }
    placePanel();
  }

  const shown = (n) => String(Math.round(n * 100) / 100);

  function renderControls() {
    for (const { name } of [...SWITCHES, ...ADVANCED_SWITCHES]) {
      const row = $(`kahoot-sw-${name}`);
      if (!row) continue;
      row.setAttribute('aria-checked', String(prefs[name]));
      row.setAttribute('aria-disabled', String(name === 'fast' && !fastModel()));
    }
    const select = $('kahoot-model');
    if (select) select.value = prefs.model;
    for (const { name, scale } of ADVANCED) {
      const field = $(`kahoot-adv-${name}`);
      // Not while it's being typed in.
      if (field && root.activeElement !== field) field.value = PREFS[name].options ? prefs[name] : shown(prefs[name] / scale);
    }
    renderDelay();
  }

  // ── ANSWER DELAY SLIDER ───────────────────────────────────────
  // One track with a thumb for the shortest wait and one for the longest. It isn't linear: a thumb's
  // place is the square root of its delay, so the half nearest 0 covers 0 to 0.5 s and the short waits
  // can be set finely with a finger. A thumb dragged past the other swaps with it and carries on as the
  // other end, so two thumbs on the same spot pull apart whichever way they're dragged. The boxes above
  // it take a typed value.
  const DELAY_TOP = PREFS.delayMax.max;
  const DELAY_TICKS = [0, 0.25, 0.5, 1, 2];
  const delayPos = (ms) => Math.sqrt(Math.min(Math.max(ms, 0), DELAY_TOP) / DELAY_TOP);
  // Rounded to 10 ms, or to 50 ms from a second up, where a pixel is worth more.
  function delayAt(pos) {
    const ms = DELAY_TOP * Math.min(Math.max(pos, 0), 1) ** 2;
    const step = ms < 1000 ? 10 : 50;
    return Math.round(ms / step) * step;
  }
  // A drag in progress, shown but not saved until the finger lifts.
  let delayDrag = null;

  function renderDelay() {
    const slider = $('kahoot-delay');
    if (!slider) return;
    const values = delayDrag?.values ?? [prefs.delayMin, prefs.delayMax];
    const [lo, hi] = values.map((v) => delayPos(v) * 100);
    const fill = $('kahoot-delay-fill');
    fill.style.left = `${lo}%`;
    fill.style.width = `${hi - lo}%`;
    ['delayMin', 'delayMax'].forEach((name, i) => {
      const thumb = $(`kahoot-delay-${i}`);
      thumb.style.left = `${i ? hi : lo}%`;
      thumb.classList.toggle('active', delayDrag?.active === i);
      thumb.setAttribute('aria-valuenow', shown(values[i] / 1000));
      thumb.setAttribute('aria-valuetext', `${shown(values[i] / 1000)} s`);
      thumb.setAttribute('aria-valuemin', i ? shown(values[0] / 1000) : '0');
      thumb.setAttribute('aria-valuemax', i ? String(DELAY_TOP / 1000) : shown(values[1] / 1000));
      const field = $(`kahoot-adv-${name}`);
      if (root.activeElement !== field) field.value = shown(values[i] / 1000);
    });
  }

  function setDelay(lo, hi) {
    if (lo === prefs.delayMin && hi === prefs.delayMax) { renderDelay(); return; }
    setPref('delayMin', lo);
    setPref('delayMax', hi);
    setStatus(`Answer delay: ${shown(lo / 1000)} to ${shown(hi / 1000)} s`);
  }

  // A finger or the mouse on the slider: grabbing a thumb drags it from where it was taken, and a tap
  // elsewhere on the track brings the nearer thumb there. Nothing moves until the pointer does, or lifts,
  // so a swipe that turns out to be scrolling the settings (the browser then cancels it) changes nothing.
  function startDelayDrag(e) {
    if (e.button !== 0 || delayDrag) return;
    // A box being typed in saves first, so the drag starts from its value.
    if (root.activeElement?.tagName === 'INPUT') root.activeElement.blur();
    const rail = $('kahoot-delay-rail').getBoundingClientRect();
    if (!rail.width) return;
    const posAt = (x) => (x - rail.left) / rail.width;
    const values = [prefs.delayMin, prefs.delayMax];
    const at = posAt(e.clientX);
    const gap = values.map((v) => Math.abs(delayPos(v) - at) * rail.width);
    const active = gap[0] < gap[1] || (gap[0] === gap[1] && at < delayPos(values[0])) ? 0 : 1;
    const grabbed = gap[active] <= 22;
    delayDrag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, posAt, values, active, offset: grabbed ? at - delayPos(values[active]) : 0 };
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // With a mouse the arrow keys can carry on from here.
    if (e.pointerType === 'mouse') $(`kahoot-delay-${active}`).focus({ preventScroll: true });
    renderDelay();
  }

  function moveDelayDrag(e) {
    const d = delayDrag;
    if (d?.pointer !== e.pointerId) return;
    d.values[d.active] = delayAt(d.posAt(e.clientX) - d.offset);
    if (d.values[0] > d.values[1]) {
      d.values.reverse();
      d.active = 1 - d.active;
      if (root.activeElement?.classList.contains('dual-thumb')) $(`kahoot-delay-${d.active}`).focus({ preventScroll: true });
    }
    renderDelay();
  }

  function endDelayDrag(e) {
    if (delayDrag?.pointer !== e.pointerId) return;
    if (e.type === 'pointerup') moveDelayDrag(e);
    const [lo, hi] = delayDrag.values;
    delayDrag = null;
    if (e.type === 'pointerup') setDelay(lo, hi);
    else renderDelay();
  }

  // Chrome takes a quick sideways flick for the start of a fling even though nothing here scrolls
  // sideways, and the fling swallows the next tap. Holding back the moves of a sideways drag stops that;
  // an up-and-down swipe is left to scroll the settings.
  function holdDelayTouch(e) {
    const t = e.touches[0];
    if (delayDrag && e.cancelable && Math.abs(t.clientX - delayDrag.x) >= Math.abs(t.clientY - delayDrag.y)) e.preventDefault();
  }

  // Arrow keys move a focused thumb a notch along the track, Page Up and Down ten, Home and End to the
  // ends. It stops at the other thumb.
  function delayKey(e, i) {
    const values = [prefs.delayMin, prefs.delayMax];
    const notches = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10, Home: -Infinity, End: Infinity }[e.key];
    if (!notches) return;
    e.preventDefault();
    const from = values[i];
    let next = delayAt(delayPos(from) + notches * 0.01);
    if (next === from) next = from + Math.sign(notches) * (from < 1000 ? 10 : 50);
    next = Math.min(Math.max(next, 0), DELAY_TOP);
    values[i] = i ? Math.max(next, values[0]) : Math.min(next, values[1]);
    setDelay(...values);
  }

  function renderAdvanced() {
    $('kahoot-advanced').hidden = !advancedOpen;
    $('kahoot-adv-chev').textContent = advancedOpen ? '▾' : '▸';
    $('kahoot-adv-toggle').setAttribute('aria-expanded', String(advancedOpen));
  }

  // A number typed into the Advanced section: keep it if it's in range, otherwise say what's allowed and
  // put the old one back. A decimal comma counts as a point.
  function commitNumber(spec, input) {
    const { min, max } = PREFS[spec.name];
    const typed = parseFloat(input.value.replace(',', '.'));
    const value = Math.round(typed * spec.scale);
    if (!Number.isFinite(typed) || value < min || value > max) {
      setStatus(`${spec.label}: use ${min / spec.scale} to ${max / spec.scale}${spec.unit ? ' ' + spec.unit : ''}`, '#f85149');
      renderControls();
      return;
    }
    setPref(spec.name, value);
    let note = `${spec.label}: ${shown(value / spec.scale)}${spec.unit ? ' ' + spec.unit : ''}`;
    // The shortest wait can't be longer than the longest.
    if (spec.name === 'delayMin' && value > prefs.delayMax) {
      setPref('delayMax', value);
      note += ' (longest raised to match)';
    }
    if (spec.name === 'delayMax' && value < prefs.delayMin) {
      setPref('delayMin', value);
      note += ' (shortest lowered to match)';
    }
    setStatus(note);
  }

  // The key row: when there's a key it shows just "saved" with change / remove, and the box to paste
  // one stays out of the way until asked for.
  function renderKey() {
    const state = $('kahoot-key-state');
    if (!state) return;
    state.textContent = apiKey ? '✓ saved' : 'not set';
    state.classList.toggle('ok', !!apiKey);
    $('kahoot-key-change').hidden = $('kahoot-key-remove').hidden = !apiKey;
    $('kahoot-key-editor').hidden = !(!apiKey || editingKey);
    renderUi();
  }

  function submitKey() {
    const input = $('kahoot-key');
    const value = input.value.trim();
    if (!KEY_SHAPE.test(value)) {
      setStatus("That doesn't look like an Anthropic API key (sk-ant-…)", '#f85149');
      return;
    }
    input.value = '';
    saveApiKey(value);
    setStatus('API key saved', '#3fb950');
  }

  const switchRow = ({ name, label, hint }) => `
    <button id="kahoot-sw-${name}" class="row" type="button" role="switch" aria-label="${label}">
      <span class="text"><span>${label}</span><span class="hint">${hint}</span></span>
      <span class="track"></span>
    </button>`;

  const fieldRow = ({ name, label, hint, unit, scale, step }) => {
    const { min, max, options } = PREFS[name];
    const control = options
      ? `<select id="kahoot-adv-${name}">${options.map((o) => `<option value="${o}">${o[0].toUpperCase() + o.slice(1)}</option>`).join('')}</select>`
      : `<span class="num-wrap">
          <input id="kahoot-adv-${name}" class="num" type="number" inputmode="decimal" step="${step}" min="${min / scale}" max="${max / scale}">
          <span class="unit">${unit}</span>
        </span>`;
    return `
      <label class="row-field">
        <span class="text"><span>${label}</span><span class="hint">${hint}</span></span>
        ${control}
      </label>`;
  };

  // Text boxes rather than number ones, so a decimal comma works, the phone shows its number pad, and a
  // tap selects what's there for typing over.
  const delayBox = ({ name, label }) => `
    <input id="kahoot-adv-${name}" class="num short" type="text" inputmode="decimal" enterkeyhint="done"
      autocomplete="off" spellcheck="false" aria-label="${label}, seconds">`;

  const delayRow = () => `
    <div class="row-field range-field">
      <div class="range-head">
        <span>Answer delay</span>
        <span class="num-wrap">
          ${delayBox(ADVANCED.find((f) => f.name === 'delayMin'))}
          <span class="unit">to</span>
          ${delayBox(ADVANCED.find((f) => f.name === 'delayMax'))}
          <span class="unit">s</span>
        </span>
      </div>
      <span class="hint">A random wait in this range before answering. Both at 0 answers at once</span>
      <div id="kahoot-delay" class="dual">
        <div id="kahoot-delay-rail" class="dual-rail">
          <div class="dual-track"><div id="kahoot-delay-fill" class="dual-fill"></div></div>
          <div id="kahoot-delay-0" class="dual-thumb" role="slider" tabindex="0" aria-label="Shortest answer delay"></div>
          <div id="kahoot-delay-1" class="dual-thumb" role="slider" tabindex="0" aria-label="Longest answer delay"></div>
        </div>
      </div>
      <div class="dual-scale" aria-hidden="true">
        <div class="dual-ticks">${DELAY_TICKS.map((s) => `<span style="left:${delayPos(s * 1000) * 100}%">${s}</span>`).join('')}</div>
      </div>
    </div>`;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'kahoot-ai-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <button id="kahoot-fab" class="fab" type="button" aria-label="Show quiz helper" hidden>⚡</button>
      <section id="kahoot-panel" class="panel" hidden>
        <div class="bar">
          <span class="logo">⚡</span>
          <div class="readout">
            <div id="kahoot-status" class="status">Waiting for question...</div>
            <div class="answer-line"><span id="kahoot-picks" class="picks"></span><span id="kahoot-answer" class="answer">—</span></div>
          </div>
          <button id="kahoot-toggle" class="icon" type="button" aria-label="Settings" aria-expanded="false">⚙</button>
          <button id="kahoot-off" class="icon" type="button" aria-label="Hide completely"
            title="Hide completely. A tap on this corner, Alt+K or a tap on the Quiz badge brings it back">⊘</button>
          <button id="kahoot-close" class="icon" type="button" aria-label="Hide">×</button>
        </div>
        <div id="kahoot-settings" class="settings" hidden>
          <div class="field-head">
            <span>API key</span>
            <span class="key-tools">
              <span id="kahoot-key-state" class="key-state"></span>
              <button id="kahoot-key-change" class="link" type="button">change</button>
              <button id="kahoot-key-remove" class="link" type="button">remove</button>
            </span>
          </div>
          <div id="kahoot-key-editor" class="editor">
            <input id="kahoot-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-...">
            <button id="kahoot-key-save" class="save" type="button">Save</button>
          </div>
          <label class="field-row">
            <span>Model</span>
            <select id="kahoot-model">${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
          </label>
          ${SWITCHES.map(switchRow).join('')}
          <button id="kahoot-adv-toggle" class="row" type="button" aria-expanded="false">
            <span class="text"><span>Advanced</span><span class="hint">Delays, thinking, timeouts, debug</span></span>
            <span id="kahoot-adv-chev" class="chev">▸</span>
          </button>
          <div id="kahoot-advanced" hidden>
            ${delayRow()}
            ${ADVANCED.filter((f) => !f.slider).map(fieldRow).join('')}
            ${ADVANCED_SWITCHES.map(switchRow).join('')}
            <button id="kahoot-adv-reset" class="reset" type="button">Reset advanced to defaults</button>
          </div>
        </div>
      </section>
    `;
    document.body.appendChild(host);

    for (const { name } of [...SWITCHES, ...ADVANCED_SWITCHES]) {
      $(`kahoot-sw-${name}`).addEventListener('click', (e) => {
        if (e.currentTarget.getAttribute('aria-disabled') === 'true') return;
        setPref(name, !prefs[name]);
      });
    }
    $('kahoot-model').addEventListener('change', (e) => setPref('model', e.target.value));

    for (const spec of ADVANCED) {
      const field = $(`kahoot-adv-${spec.name}`);
      field.addEventListener('change', () => (PREFS[spec.name].options ? setPref(spec.name, field.value) : commitNumber(spec, field)));
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
      // A tick later, or the tap that focused it puts the caret back.
      if (spec.slider) field.addEventListener('focus', () => setTimeout(() => field.select()));
    }
    const delaySlider = $('kahoot-delay');
    delaySlider.addEventListener('pointerdown', startDelayDrag);
    delaySlider.addEventListener('pointermove', moveDelayDrag);
    delaySlider.addEventListener('pointerup', endDelayDrag);
    delaySlider.addEventListener('pointercancel', endDelayDrag);
    delaySlider.addEventListener('touchmove', holdDelayTouch, { passive: false });
    [0, 1].forEach((i) => $(`kahoot-delay-${i}`).addEventListener('keydown', (e) => delayKey(e, i)));
    $('kahoot-adv-toggle').addEventListener('click', () => {
      advancedOpen = !advancedOpen;
      renderAdvanced();
      if (advancedOpen) $('kahoot-advanced').scrollIntoView?.({ block: 'nearest' });
    });
    $('kahoot-adv-reset').addEventListener('click', () => {
      for (const { name } of [...ADVANCED, ...ADVANCED_SWITCHES]) setPref(name, PREFS[name].fallback);
      setStatus('Advanced settings reset');
    });

    // Keep Kahoot's own keyboard handling away from what's typed in the panel.
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    const keyInput = $('kahoot-key');
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });
    $('kahoot-key-save').addEventListener('click', submitKey);
    $('kahoot-key-change').addEventListener('click', () => {
      editingKey = !editingKey;
      renderKey();
      if (editingKey) keyInput.focus();
    });
    $('kahoot-key-remove').addEventListener('click', () => {
      saveApiKey('');
      setStatus('API key removed');
    });

    // Settings fold open from the bar, and the whole panel folds away to a small ⚡ button, or to the
    // same button made invisible.
    $('kahoot-toggle').addEventListener('click', () => setPref('ui', uiState() === 'open' ? 'compact' : 'open'));
    $('kahoot-off').addEventListener('click', () => setPref('ui', 'off'));
    $('kahoot-close').addEventListener('click', () => setPref('ui', 'hidden'));
    $('kahoot-fab').addEventListener('click', () => setPref('ui', 'compact'));

    // Alt+K hides everything, or brings the panel back. Matched by key position, since Alt+K types a
    // letter on a Mac.
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyK' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      setPref('ui', uiState() === 'off' ? 'compact' : 'off');
    }, true);

    // A tap on the badge shows or hides the panel. Caught at the document, before Kahoot sees it, so it
    // keeps working however many times Kahoot swaps the badge for a new one.
    document.addEventListener('click', (e) => {
      const target = findBadge();
      if (!target || !target.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setPref('ui', panelShown() ? 'hidden' : 'compact');
    }, true);

    renderControls();
    renderAdvanced();
    renderKey();
    syncLauncher();
  }

  // ── ROUNDS ────────────────────────────────────────────────────
  // A round is one question, from the first time we see it until its answer screen is gone. The same
  // question can reach us more than once: the first one is sent when the game starts and again when it
  // begins, a reconnect redelivers messages, and the page shows it too, sometimes worded a little
  // differently. A question that matches the open round is that same question, never a new one.
  let round = null;
  let roundsStarted = 0;
  let lastSeq = 0;
  // The question the page is showing that we've already dealt with. Ignored until it leaves the screen.
  let domGate = null;

  // A question is known by its text, or on AhaSlides by its slide.
  const keyOf = (q) => q.key ?? textKey(q.question);
  const fromWire = (q) => q.source === 'ws' || q.source === 'http';

  const isRepeat = (key) => {
    if (!round) return false;
    if (!round.keys.some((k) => sameText(k, key))) return false;
    return !round.over || Date.now() - round.overAt < REPEAT_WINDOW_MS;
  };

  // The round ends when its answer buttons have been on screen and are gone again. On AhaSlides, when
  // its slide has been on the question screen and has left it.
  function trackRound() {
    if (!round || round.over) return;
    if (SITE === 'aha' ? ahaLive(round.q) : buttonFor(0)) round.sawButtons = true;
    else if (round.sawButtons) {
      round.over = true;
      round.overAt = Date.now();
    }
  }

  // The next question to answer, or null. The wire comes first, then the page.
  function pendingQuestion() {
    if (incoming && incoming.seq > lastSeq) {
      const wire = incoming;
      lastSeq = wire.seq;
      if (!isRepeat(textKey(wire.question))) return wire;
      console.debug(LOG, 'Same question again, not asking twice:', wire.question);
    }

    const dom = getQuestionDataFromDom();
    if (!dom) { domGate = null; return null; }
    const key = keyOf(dom);
    if (domGate && sameText(domGate, key)) return null;
    domGate = key;
    if (isRepeat(key)) return null;
    // The open round came from the wire and this is the first question the page shows: it's that
    // question, worded differently. (A stale one from before the round began is held by domGate.)
    if (round && !round.over && !round.aliased && fromWire(round.q)) {
      round.keys.push(key);
      round.aliased = true;
      console.debug(LOG, 'Page shows the question worded differently:', dom.question);
      return null;
    }
    return { source: 'dom', ...dom };
  }

  function startRound(q) {
    if (round) round.cancelled = true; // an older question must not answer for this one
    clearMark();
    const dom = getQuestionDataFromDom();
    if (dom) domGate = keyOf(dom);
    round = { q, keys: [keyOf(q)], aliased: false, startedAt: Date.now(), liveAt: 0, sawButtons: false, over: false, overAt: 0, cancelled: false, pick: undefined };
    roundsStarted++;
    handleQuestion(q, round);
  }

  // Where the picked answers are on screen: the button found, or on AhaSlides every option picked when
  // several are right. None when the answer isn't a button to tap.
  function picksOnScreen(q, answer, button) {
    if (button === null) return [];
    if (SITE !== 'aha') return [button];
    const options = ahaEls('audience-quiz-option');
    return [].concat(answer).map((index) => options.indexOf(ahaOption(q.answers.find((a) => a.index === index).id))).filter((i) => i >= 0);
  }

  // Wait this long before answering, so it isn't instant, but never so long that the timer runs out.
  function answerDelay(q, since) {
    const wanted = prefs.delayMin + Math.random() * (prefs.delayMax - prefs.delayMin);
    if (!q.time) return wanted;
    return Math.max(0, Math.min(wanted, q.time - prefs.margin - (Date.now() - since)));
  }

  async function handleQuestion(q, r) {
    // A newer question takes over the panel, so a finished-off one must stay quiet.
    const say = (text, color) => { if (!r.cancelled) setStatus(text, color); };
    const show = (text) => { if (!r.cancelled) setAnswer(text); };
    try {
      if (q.unsupported) {
        say(`Skipped: ${q.unsupported} question`);
        show('—');
        return;
      }

      // On Menti the answer may be there already (see ANSWER AHEAD), or on its way.
      const entry = SITE === 'menti' ? askCached(q) : startAsk(q);
      say(ready(entry) ? 'Answer ready (asked ahead)' : `Asking ${modelName(prefs.model)}${prefs.webSearch ? ' + web' : ''}... (${q.source})`, '#f0a500');
      show('—');

      const answer = await answerBy(entry, q, r);
      if (r.cancelled) return;
      if (answer === null) {
        say("Couldn't get answer", '#f85149');
        return;
      }
      show(kindOf(q).show(q, answer));
      // Said with the outcome, so a search that keeps failing doesn't go unnoticed.
      const noSearch = r.withoutSearch ? ` — no web search (${r.withoutSearch})` : '';

      // The question often arrives before its buttons do. On AhaSlides, it's read on the rules screen.
      say('Waiting for the answer buttons...', '#f0a500');
      const button = SITE === 'aha' ? await waitForAhaControls(q, answer, r) : await waitForButton(q, answer, r);
      if (r.cancelled) return;
      if (button < 0) {
        say("Couldn't find that answer on screen — answer above", '#f85149');
        return;
      }

      r.pick = button ?? undefined; // AhaSlides has nothing to highlight but multiple choice
      syncMark();
      if (!r.cancelled) setPicks(picksOnScreen(q, answer, button));
      // A question read off the page was already up when its round started; one from the wire or
      // AhaSlides' store went live at r.liveAt (see seenLive), which may be a while back if the answer
      // waited on a search.
      const delay = answerDelay(q, q.source === 'dom' ? r.startedAt : r.liveAt || Date.now());
      if (prefs.autoAnswer) say(`Answering in ${(delay / 1000).toFixed(1)}s...`, '#f0a500');
      else say('Auto-answer is off — answer above' + noSearch);
      await sleep(delay);
      if (r.cancelled) return;

      // Checked here, after the wait, so flipping the switch while waiting counts.
      if (!prefs.autoAnswer) {
        say('Auto-answer is off — answer above' + noSearch);
        return;
      }

      const result = SITE === 'menti' ? await tapAnswer(button)
        : SITE === 'aha' ? await enterAhaAnswer(q, answer, r)
        : submitAnswer(answer, button);
      if (r.cancelled) return;
      if (result === 'sent') say('✓ Answered (sent over WebSocket)' + noSearch, '#3fb950');
      else if (result === 'tapped') say('✓ Answered (tapped on the page)' + noSearch, '#3fb950');
      else if (result === 'entered') say('✓ Answered (entered on the page)' + noSearch, '#3fb950');
      else if (result === 'stuck') say("Couldn't enter all of it — answer above", '#f85149');
      else if (result === 'nosocket') say("Can't auto-answer: no open WebSocket (Kahoot may be on HTTP) — answer above", '#f85149');
      else say('Answer buttons were gone — answer above', '#f85149');
    } catch (e) {
      say('Error: ' + e.message, '#f85149');
    }
  }

  function loop() {
    try {
      syncLauncher();
      trackRound();
      const q = pendingQuestion();
      if (q) startRound(q);
    } catch (e) {
      console.error(LOG, e);
    }
    setTimeout(loop, 300);
  }

  // Menti's page is rebuilt for each question. Note when it changes, so the screen is only scanned again
  // then (see mentiScreen), not on every tick while the page sits still.
  function watchPage() {
    new MutationObserver(() => { screenDirty = true; })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }

  function start() {
    if (SITE === 'menti') watchPage();
    buildUI();
    loop();
  }

  // Document-start means <body> doesn't exist yet. The hooks above are already live; the panel waits.
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

})();
