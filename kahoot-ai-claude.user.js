// ==UserScript==
// @name         Kahoot AI Helper - Claude (HTTP + WebSocket)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Answers Kahoot questions with Claude. Auto-answers over Kahoot’s WebSocket, with a choice of model, optional web search and fast mode, and an optional answer highlight. Reads questions from the WebSocket or HTTP long-polling traffic, and falls back to the page.
// @match        https://kahoot.it/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js
// @downloadURL  https://raw.githubusercontent.com/GameOneDev/money-glitch-free/main/kahoot-ai-claude.user.js
// ==/UserScript==

(function () {
  "use strict";

  // Keep this file free of the straight single quote (U+0027), comments included: use " or ` for
  // strings and ’ in text. Orion on iOS can double or drop that character in a userscript saved by
  // Violentmonkey, which breaks the whole script with a SyntaxError after a reload until it is reinstalled.

  // ── SETTINGS ──────────────────────────────────────────────────
  // The API key isn’t here: paste it in the panel. It’s kept in the browser, so updating the script
  // doesn’t wipe it and it can’t end up in a repo.
  // The panel’s model menu. The first one is where it starts; after that it remembers.
  const MODELS = [
    { id: "claude-haiku-5-5", name: "Haiku 5.5" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Opus 5.5" },
    // { id: "claude-fable-5-1", name: "Fable 5.1" },
  ];
  // Fast mode (speed: "fast") is a research preview that only some models have, at twice the price.
  const FAST_MODELS = new Set(["claude-opus-5-5"]);
  const FAST_BETA = "fast-mode-2026-02-01";
  // These seven are where the panel’s Advanced section starts. Change them there: it remembers.
  // How long Claude thinks before it answers: low, medium or high.
  const EFFORT = "low";
  // Web searches Claude may run per question.
  const MAX_SEARCHES = 2;
  // How long to wait for Claude, and for Claude with web search, before giving up.
  const API_TIMEOUT_MS = 20000;
  const SEARCH_TIMEOUT_MS = 40000;
  // A random pause before sending the answer, so it isn’t instant. Both at 0 answers at once.
  const ANSWER_DELAY_MIN = 150;
  const ANSWER_DELAY_MAX = 700;
  // Never wait so long that less than this much of the question’s timer is left to answer in.
  const TIMER_MARGIN_MS = 2500;
  // Print Kahoot’s game messages (both directions) in the console, for working out why an answer
  // isn’t taken.
  const TRACE = false;

  // Not in the panel.
  // Claude 5.x models think before they answer, and that thinking counts toward max_tokens, so the
  // longer it’s allowed to think the more room it needs. With web search it also writes its queries.
  const TOKENS_BY_EFFORT = { low: 1024, medium: 4096, high: 8192 };
  const SEARCH_EXTRA_TOKENS = 3072;
  const MAX_CONTINUATIONS = 3;
  // How long to wait for the answer buttons to show up and become clickable.
  const BUTTON_WAIT_MS = 30000;
  // CometD can redeliver a message after a reconnect. A question matching the one that just finished,
  // arriving this soon after, is that and not a new question.
  const REPEAT_WINDOW_MS = 10000;

  const LOG = "[Kahoot AI]";
  const API_URL = "https://api.anthropic.com/v1/messages";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── PANEL SETTINGS ────────────────────────────────────────────
  // What the panel’s switches and menu hold. Saved in this browser, so they stick between games.
  const PREFS = {
    autoAnswer: { key: "kahoot-ai-auto-answer", fallback: true },   // send Claude’s answer for you
    highlight:  { key: "kahoot-ai-highlight",   fallback: true },   // outline the answer on screen
    webSearch:  { key: "kahoot-ai-web-search",  fallback: false },  // let Claude search the web
    fast:       { key: "kahoot-ai-fast",        fallback: false },  // speed: "fast"
    model:      { key: "kahoot-ai-model",       fallback: MODELS[0].id, options: MODELS.map((m) => m.id) },
    ui:         { key: "kahoot-ai-ui",          fallback: "compact", options: ["compact", "open", "hidden"] },
    // The Advanced section. Times are kept in milliseconds, and the panel shows seconds.
    delayMin:      { key: "kahoot-ai-delay-min",      fallback: ANSWER_DELAY_MIN,  min: 0,     max: 30000 },
    delayMax:      { key: "kahoot-ai-delay-max",      fallback: ANSWER_DELAY_MAX,  min: 0,     max: 30000 },
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
    // Anything saved that this version doesn’t know (a model that’s gone, a number out of range) goes
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
    console.log(LOG, name, "=", value);
  }

  const modelName = (id) => MODELS.find((m) => m.id === id)?.name ?? id;
  const fastModel = () => FAST_MODELS.has(prefs.model);

  // The API key. Saved in this page’s local storage, so any script that runs on kahoot.it can read it
  // (the requests to Anthropic are made from the page, so they could be watched anyway). Use a key
  // made for this, with a spend limit.
  const KEY_STORAGE = "kahoot-ai-api-key";
  const KEY_SHAPE = /^sk-ant-\S{10,}$/;
  let apiKey = "";
  try { apiKey = localStorage.getItem(KEY_STORAGE) || ""; } catch (_) {}
  let editingKey = false;

  function saveApiKey(value) {
    apiKey = value;
    editingKey = false;
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (_) {}
    renderKey();
  }

  // ── READ QUESTIONS FROM KAHOOT’S TRAFFIC ──────────────────────
  // Kahoot’s client talks CometD over a WebSocket, or over HTTP long-polling when the WebSocket
  // can’t connect. Either way the question shows up as a message with JSON in data.content, so
  // watch both and keep the newest question. That works even when the page doesn’t show the text.
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

  // What it takes to send an answer ourselves, learned from Kahoot’s traffic in both directions.
  let activeWs = null;
  let clientId = null;
  let gameId = null;
  let msgId = 0;
  let answerDataId = 45; // the data.id Kahoot’s own client puts on an answer
  let wireIndex = null;  // the question number, when Kahoot’s messages say which one it is

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

  const isCometdUrl = url => String(url ?? "").includes("/cometd/");

  // HTTP long-polling: XMLHttpRequest, which is what CometD uses, and fetch in case that changes.
  const OldXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isCometdUrl(url) && !this.__kahootAiHooked) {
      this.__kahootAiHooked = true;
      this.addEventListener("load", onCometdXhrLoad);
    }
    return OldXhrOpen.apply(this, arguments);
  };

  function onCometdXhrLoad() {
    if (this.status < 200 || this.status >= 300 || !isCometdUrl(this.responseURL)) return;
    try {
      if (this.responseType === "json") handleKahootMessages(this.response, "http");
      else if (this.responseType === "" || this.responseType === "text") handleKahootMessages(JSON.parse(this.responseText), "http");
    } catch (e) { console.debug(LOG, "XHR parse error:", e.message); }
  }

  const OldFetch = window.fetch;
  window.fetch = function (input) {
    const request = OldFetch.apply(this, arguments);
    if (isCometdUrl(typeof input === "string" ? input : input?.url)) {
      request
        .then(resp => resp.clone().text())
        .then(text => handleKahootMessages(JSON.parse(text), "http"))
        .catch(e => console.debug(LOG, "fetch parse error:", e.message));
    }
    return request;
  };

  // WebSocket.
  const OldWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OldWebSocket(url, protocols) : new OldWebSocket(url);
    activeWs = ws;
    ws.addEventListener("message", event => {
      try {
        if (typeof event.data === "string") handleKahootMessages(JSON.parse(event.data), "ws");
      } catch (e) { console.debug(LOG, "WS parse error:", e.message); }
    });

    // Watch what Kahoot’s own client sends: that’s where the client id and message numbers come from,
    // and where an answer’s exact shape can be read off when you answer one yourself.
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
  const buttonFor = (index) => document.querySelector(`[data-functional-selector="answer-${index}"]`);
  const choiceTextEl = (index) => document.querySelector(`[data-functional-selector="question-choice-text-${index}"]`);

  function getQuestionDataFromDom() {
    const question = document.querySelector(`[data-functional-selector="block-title"]`)?.textContent?.trim();
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
  const textKey = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(fast ? { "anthropic-beta": FAST_BETA } : {}),
        },
        body: JSON.stringify(fast ? { ...body, speed: "fast" } : body),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      return { response, json };
    } catch (e) {
      const timedOut = e.name === "AbortError";
      const error = new Error(timedOut ? "Claude request timed out" : e.message);
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
      if (content[i].type === "text") parts.unshift(content[i].text);
      else if (content[i].type !== "thinking") break;
    }
    return parts.join("").trim();
  }

  async function askClaude(data) {
    if (!apiKey) {
      const error = new Error("No API key — paste it in the panel");
      error.fatal = true;
      throw error;
    }
    const search = prefs.webSearch;
    let fast = prefs.fast && fastModel();
    const answersText = data.answers.map((a) => `${a.index}: ${a.text}`).join("\n");
    const validNumbers = data.answers.map((a) => a.index).join(", ");
    const prompt = `You are answering a quiz question. ${search ? "If you are not sure of the answer you may search the web, but answer straight away when you know it. " : ""}Reply with ONLY the number of the correct answer (${validNumbers}). No explanation, no punctuation, just the number.

Question: ${data.question}

Answers:
${answersText}`;

    const body = {
      model: prefs.model,
      max_tokens: TOKENS_BY_EFFORT[prefs.effort] + (search ? SEARCH_EXTRA_TOKENS : 0),
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: prefs.effort },
    };
    if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: prefs.maxSearches }];
    const timeoutMs = search ? prefs.searchTimeout : prefs.timeout;

    let json;
    for (let step = 0; ; step++) {
      let { response, json: reply } = await callApi(body, fast, timeoutMs);
      // Fast mode has its own rate limit, and not every account has it. Use normal speed instead.
      if (fast && (response.status === 429 || (response.status === 400 && /speed|fast/i.test(reply.error?.message ?? "")))) {
        console.log(LOG, "Fast mode was refused, using normal speed:", reply.error?.message ?? `HTTP ${response.status}`);
        fast = false;
        ({ response, json: reply } = await callApi(body, false, timeoutMs));
      }
      if (response.status === 401) {
        const error = new Error("Invalid API key — paste a new one in the panel");
        error.fatal = true;
        throw error;
      }
      if (!response.ok) throw new Error(reply.error?.message || `HTTP ${response.status}`);

      json = reply;
      // A long search turn can pause. Hand back what it has so far and it carries on.
      if (json.stop_reason !== "pause_turn" || step >= MAX_CONTINUATIONS) break;
      body.messages = [...body.messages, { role: "assistant", content: json.content }];
    }

    const text = finalText(json.content);
    if (!text) {
      if (json.stop_reason === "refusal") throw new Error("Claude declined this question");
      if (json.stop_reason === "max_tokens") throw new Error("Claude ran out of tokens");
      if (json.stop_reason === "pause_turn") throw new Error("Claude was still searching");
      return null;
    }

    // The last whole number that is one of the answers, so a "2007" in its words can’t be mistaken for one.
    const numbers = (text.match(/\b\d+\b/g) || []).map(Number).filter((n) => data.answers.some((a) => a.index === n));
    return numbers.length ? numbers[numbers.length - 1] : null;
  }

  // One retry, since a single hiccup shouldn’t cost the question. A bad key won’t fix itself,
  // and a request that already timed out would only cost the same time again.
  async function askWithRetry(data) {
    for (let attempt = 0; ; attempt++) {
      try {
        const index = await askClaude(data);
        if (index !== null || attempt >= 1) return index;
      } catch (e) {
        if (e.fatal || e.timeout || attempt >= 1) throw e;
      }
      await sleep(700);
    }
  }

  // ── FIND THE ANSWER BUTTON ────────────────────────────────────
  // Which button holds this answer? Kahoot can shuffle the buttons for a player, so go by the text on
  // the page when it’s there, else by position. -1 when the buttons aren’t there yet, or when the page
  // shows other answers (an older question’s screen).
  function locateButton(q, index) {
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
  // answers. That’s also the sign the question is live. If it never enables, return the button anyway.
  async function waitForButton(q, index, r) {
    const startedWaiting = Date.now();
    const deadline = startedWaiting + BUTTON_WAIT_MS;
    let found = -1;
    let reported = false;
    while (!r.cancelled && Date.now() < deadline) {
      found = locateButton(q, index);
      if (found >= 0) {
        r.sawButtons = true;
        const disabled = buttonFor(found).disabled;
        if (!reported) {
          reported = true;
          console.log(LOG, `Answer button ${found} is on screen (${disabled ? "disabled" : "enabled"}) after ${Date.now() - startedWaiting}ms`);
        }
        if (!disabled) return found;
      }
      await sleep(100);
    }
    if (!r.cancelled) console.log(LOG, found >= 0 ? `Answer button ${found} never got enabled` : "Never found the answer button");
    return found;
  }

  // ── SEND THE ANSWER ───────────────────────────────────────────
  // Answer the way Kahoot’s own client does: a message on /service/controller over the WebSocket.
  // There’s no socket to send on when Kahoot is on HTTP long-polling, or before it has connected.
  const canSendOverWs = () => !!activeWs && activeWs.readyState === 1 && !!gameId && !!clientId;

  // Returns ’sent’, ’nosocket’ (nothing to send on), or ’missed’ (the question screen was already gone).
  function submitAnswer(index, button) {
    if (!buttonFor(button)) return "missed";
    if (!canSendOverWs()) return "nosocket";
    const questionIndex = wireIndex ?? roundsStarted - 1;
    const packet = [{
      id: String(++msgId),
      channel: "/service/controller",
      data: {
        gameid: gameId, type: "message", host: "kahoot.it", id: answerDataId,
        content: JSON.stringify({ type: "quiz", choice: index, questionIndex, meta: { lag: Math.floor(10 + Math.random() * 40) } })
      },
      clientId, ext: {}
    }];
    activeWs.send(JSON.stringify(packet));
    console.log(LOG, `Answer ${index} sent over the WebSocket (question ${questionIndex}, ${wireIndex === null ? "counted" : "from Kahoot"})`);
    return "sent";
  }

  // ── ANSWER HIGHLIGHT ──────────────────────────────────────────
  // A soft outline over the answer Claude picked. Drawn over the page, not in it (in the panel’s
  // shadow root), so Kahoot re-rendering or restyling can’t touch it, and it follows the button until
  // the question screen goes away.
  let mark = null; // { chosen, el }

  function showMark(chosen) {
    if (mark?.chosen === chosen || !root) return;
    clearMark();
    const el = document.createElement("div");
    el.className = "ring";
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
  // The panel lives in a shadow root, so Kahoot’s own styles can’t reach in and restyle it (a page
  // rule squeezing the key box is what that prevents), and nothing here leaks out to the page. It is
  // made for a phone first: a one-line bar that keeps the answer in view with the settings folded
  // away, big tap targets, and 16px text in the boxes (anything smaller makes iOS zoom in).
  let root = null;
  const $ = (id) => root?.getElementById(id) ?? null;

  // Kahoot’s top bar has a badge ("Quiz") on the question screens. That’s the panel’s button while it’s
  // there; the ⚡ button is for everywhere else, like the lobby. Kahoot’s class names are generated, so
  // find it by the label’s data attribute, and take the label’s parent, which holds the icon as well.
  const BADGE_LABEL = `[data-functional-selector^="question-type-heading"]`;
  const findBadge = () => document.querySelector(BADGE_LABEL)?.parentElement ?? null;
  let badge = null;

  const SWITCHES = [
    { name: "autoAnswer", label: "Auto-answer", hint: "Sends Claude’s answer for you" },
    { name: "highlight", label: "Highlight answer", hint: "A soft outline on the pick" },
    { name: "webSearch", label: "Web search", hint: "Slower, and each search is billed" },
    { name: "fast", label: "Fast mode", hint: "Opus 5.5 only, at twice the price" },
  ];

  // The Advanced section, folded away until asked for. `scale` turns the saved value into what’s shown
  // (milliseconds into seconds). A field with options in PREFS is a menu, the rest are numbers.
  const ADVANCED = [
    { name: "delayMin", label: "Answer delay, shortest", hint: "Wait at least this long before answering", unit: "s", scale: 1000, step: 0.05 },
    { name: "delayMax", label: "Answer delay, longest", hint: "A random wait up to this. Both at 0 answers at once", unit: "s", scale: 1000, step: 0.05 },
    { name: "margin", label: "Timer margin", hint: "Always leave this much of the question’s timer", unit: "s", scale: 1000, step: 0.5 },
    { name: "effort", label: "Thinking effort", hint: "Higher is slower, and better on hard questions" },
    { name: "maxSearches", label: "Web searches", hint: "The most it may run per question", unit: "", scale: 1, step: 1 },
    { name: "timeout", label: "Request timeout", hint: "Give up on Claude after this long", unit: "s", scale: 1000, step: 1 },
    { name: "searchTimeout", label: "Timeout with search", hint: "Searching takes longer", unit: "s", scale: 1000, step: 1 },
  ];
  const ADVANCED_SWITCHES = [
    { name: "trace", label: "Debug log", hint: "Prints Kahoot’s messages in the browser console" },
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
      width: 44px; height: 44px; border: 0; border-radius: 50%; padding: 0;
      background: #58a6ff; color: #0f1117; font-size: 20px; font-weight: 700; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, .4);
    }

    .bar { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 6px 6px 6px 12px; }
    .logo { flex: none; color: #58a6ff; font-size: 18px; }
    .readout { flex: 1; min-width: 0; }
    .status {
      color: #8b949e; font-size: 12px; overflow: hidden; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .answer { color: #3fb950; font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
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
      content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
      border-radius: 50%; background: #e2e8f0; transition: transform .15s;
    }
    .row[aria-checked="true"] .track { background: #238636; }
    .row[aria-checked="true"] .track::after { transform: translateX(20px); }
    .row[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
  `;

  function setStatus(text, color) {
    const el = $("kahoot-status");
    if (el) { el.textContent = text; el.style.color = color || ""; }
  }

  function setAnswer(text, color) {
    const el = $("kahoot-answer");
    if (el) { el.textContent = text; el.style.color = color || ""; }
  }

  // With no key the settings stay open, since there’s nothing to do until one is pasted.
  function uiState() {
    if (prefs.ui === "hidden") return "hidden";
    return !apiKey || prefs.ui === "open" ? "open" : "compact";
  }

  function renderUi() {
    if (!root) return;
    const state = uiState();
    $("kahoot-fab").hidden = state !== "hidden" || !!badge;
    $("kahoot-panel").hidden = state === "hidden";
    $("kahoot-settings").hidden = state !== "open";
    $("kahoot-toggle").setAttribute("aria-expanded", String(state === "open"));
    styleBadge();
    placePanel(); // so it opens where it belongs, not a tick later
  }

  // The badge looks tappable, and lit while the panel is up.
  function styleBadge() {
    if (!badge) return;
    badge.style.cursor = "pointer";
    badge.style.outline = uiState() === "hidden" ? "" : "2px solid rgba(88, 166, 255, .75)";
    badge.style.outlineOffset = "2px";
  }

  // Keep the panel just under the badge, so it never covers the button that closes it.
  function placePanel() {
    const panel = $("kahoot-panel");
    if (!panel) return;
    if (!badge) {
      panel.style.top = panel.style.maxHeight = "";
      return;
    }
    const top = Math.max(8, Math.round(badge.getBoundingClientRect().bottom) + 8);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
    panel.style.maxHeight = `calc(100dvh - ${top + 8}px)`; // ignored where dvh isn’t known
  }

  // Kahoot re-renders its top bar between screens, so look again each time round rather than hold on
  // to one element.
  function syncLauncher() {
    if (!root) return;
    const found = findBadge();
    if (found !== badge) {
      if (badge) badge.style.cursor = badge.style.outline = badge.style.outlineOffset = "";
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
      row.setAttribute("aria-checked", String(prefs[name]));
      row.setAttribute("aria-disabled", String(name === "fast" && !fastModel()));
    }
    const select = $("kahoot-model");
    if (select) select.value = prefs.model;
    for (const { name, scale } of ADVANCED) {
      const field = $(`kahoot-adv-${name}`);
      // Not while it’s being typed in.
      if (field && root.activeElement !== field) field.value = PREFS[name].options ? prefs[name] : shown(prefs[name] / scale);
    }
  }

  function renderAdvanced() {
    $("kahoot-advanced").hidden = !advancedOpen;
    $("kahoot-adv-chev").textContent = advancedOpen ? "▾" : "▸";
    $("kahoot-adv-toggle").setAttribute("aria-expanded", String(advancedOpen));
  }

  // A number typed into the Advanced section: keep it if it’s in range, otherwise say what’s allowed and
  // put the old one back.
  function commitNumber(spec, input) {
    const { min, max } = PREFS[spec.name];
    const typed = parseFloat(input.value);
    const value = Math.round(typed * spec.scale);
    if (!Number.isFinite(typed) || value < min || value > max) {
      setStatus(`${spec.label}: use ${min / spec.scale} to ${max / spec.scale}${spec.unit ? " " + spec.unit : ""}`, "#f85149");
      renderControls();
      return;
    }
    setPref(spec.name, value);
    let note = `${spec.label}: ${shown(value / spec.scale)}${spec.unit ? " " + spec.unit : ""}`;
    // The shortest wait can’t be longer than the longest.
    if (spec.name === "delayMin" && value > prefs.delayMax) {
      setPref("delayMax", value);
      note += " (longest raised to match)";
    }
    if (spec.name === "delayMax" && value < prefs.delayMin) {
      setPref("delayMin", value);
      note += " (shortest lowered to match)";
    }
    setStatus(note);
  }

  // The key row: when there’s a key it shows just "saved" with change / remove, and the box to paste
  // one stays out of the way until asked for.
  function renderKey() {
    const state = $("kahoot-key-state");
    if (!state) return;
    state.textContent = apiKey ? "✓ saved" : "not set";
    state.classList.toggle("ok", !!apiKey);
    $("kahoot-key-change").hidden = $("kahoot-key-remove").hidden = !apiKey;
    $("kahoot-key-editor").hidden = !(!apiKey || editingKey);
    renderUi();
  }

  function submitKey() {
    const input = $("kahoot-key");
    const value = input.value.trim();
    if (!KEY_SHAPE.test(value)) {
      setStatus("That doesn’t look like an Anthropic API key (sk-ant-…)", "#f85149");
      return;
    }
    input.value = "";
    saveApiKey(value);
    setStatus("API key saved", "#3fb950");
  }

  const switchRow = ({ name, label, hint }) => `
    <button id="kahoot-sw-${name}" class="row" type="button" role="switch" aria-label="${label}">
      <span class="text"><span>${label}</span><span class="hint">${hint}</span></span>
      <span class="track"></span>
    </button>`;

  const fieldRow = ({ name, label, hint, unit, scale, step }) => {
    const { min, max, options } = PREFS[name];
    const control = options
      ? `<select id="kahoot-adv-${name}">${options.map((o) => `<option value="${o}">${o[0].toUpperCase() + o.slice(1)}</option>`).join("")}</select>`
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

  function buildUI() {
    const host = document.createElement("div");
    host.id = "kahoot-ai-host";
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <button id="kahoot-fab" class="fab" type="button" aria-label="Show Kahoot Helper" hidden>⚡</button>
      <section id="kahoot-panel" class="panel" hidden>
        <div class="bar">
          <span class="logo">⚡</span>
          <div class="readout">
            <div id="kahoot-status" class="status">Waiting for question...</div>
            <div id="kahoot-answer" class="answer">—</div>
          </div>
          <button id="kahoot-toggle" class="icon" type="button" aria-label="Settings" aria-expanded="false">⚙</button>
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
            <select id="kahoot-model">${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select>
          </label>
          ${SWITCHES.map(switchRow).join("")}
          <button id="kahoot-adv-toggle" class="row" type="button" aria-expanded="false">
            <span class="text"><span>Advanced</span><span class="hint">Delays, thinking, timeouts, debug</span></span>
            <span id="kahoot-adv-chev" class="chev">▸</span>
          </button>
          <div id="kahoot-advanced" hidden>
            ${ADVANCED.map(fieldRow).join("")}
            ${ADVANCED_SWITCHES.map(switchRow).join("")}
            <button id="kahoot-adv-reset" class="reset" type="button">Reset advanced to defaults</button>
          </div>
        </div>
      </section>
    `;
    document.body.appendChild(host);

    for (const { name } of [...SWITCHES, ...ADVANCED_SWITCHES]) {
      $(`kahoot-sw-${name}`).addEventListener("click", (e) => {
        if (e.currentTarget.getAttribute("aria-disabled") === "true") return;
        setPref(name, !prefs[name]);
      });
    }
    $("kahoot-model").addEventListener("change", (e) => setPref("model", e.target.value));

    for (const spec of ADVANCED) {
      const field = $(`kahoot-adv-${spec.name}`);
      field.addEventListener("change", () => (PREFS[spec.name].options ? setPref(spec.name, field.value) : commitNumber(spec, field)));
      field.addEventListener("keydown", (e) => { if (e.key === "Enter") field.blur(); });
    }
    $("kahoot-adv-toggle").addEventListener("click", () => {
      advancedOpen = !advancedOpen;
      renderAdvanced();
      if (advancedOpen) $("kahoot-advanced").scrollIntoView?.({ block: "nearest" });
    });
    $("kahoot-adv-reset").addEventListener("click", () => {
      for (const { name } of [...ADVANCED, ...ADVANCED_SWITCHES]) setPref(name, PREFS[name].fallback);
      setStatus("Advanced settings reset");
    });

    // Keep Kahoot’s own keyboard handling away from what’s typed in the panel.
    for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, (e) => e.stopPropagation());
    const keyInput = $("kahoot-key");
    keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitKey(); });
    $("kahoot-key-save").addEventListener("click", submitKey);
    $("kahoot-key-change").addEventListener("click", () => {
      editingKey = !editingKey;
      renderKey();
      if (editingKey) keyInput.focus();
    });
    $("kahoot-key-remove").addEventListener("click", () => {
      saveApiKey("");
      setStatus("API key removed");
    });

    // Settings fold open from the bar, and the whole panel folds away to a small ⚡ button.
    $("kahoot-toggle").addEventListener("click", () => setPref("ui", uiState() === "open" ? "compact" : "open"));
    $("kahoot-close").addEventListener("click", () => setPref("ui", "hidden"));
    $("kahoot-fab").addEventListener("click", () => setPref("ui", "compact"));

    // A tap on the badge shows or hides the panel. Caught at the document, before Kahoot sees it, so it
    // keeps working however many times Kahoot swaps the badge for a new one.
    document.addEventListener("click", (e) => {
      const target = findBadge();
      if (!target || !target.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setPref("ui", uiState() === "hidden" ? "compact" : "hidden");
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
  // The question the page is showing that we’ve already dealt with. Ignored until it leaves the screen.
  let domGate = null;

  const isRepeat = (text) => {
    if (!round) return false;
    const key = textKey(text);
    if (!round.keys.some((k) => sameText(k, key))) return false;
    return !round.over || Date.now() - round.overAt < REPEAT_WINDOW_MS;
  };

  // The round ends when its answer buttons have been on screen and are gone again.
  function trackRound() {
    if (!round || round.over) return;
    if (buttonFor(0)) round.sawButtons = true;
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
      if (!isRepeat(wire.question)) return wire;
      console.debug(LOG, "Same question again, not asking twice:", wire.question);
    }

    const dom = getQuestionDataFromDom();
    if (!dom) { domGate = null; return null; }
    const key = textKey(dom.question);
    if (domGate && sameText(domGate, key)) return null;
    domGate = key;
    if (isRepeat(dom.question)) return null;
    // The open round came from the wire and this is the first question the page shows: it’s that
    // question, worded differently. (A stale one from before the round began is held by domGate.)
    if (round && !round.over && !round.aliased && round.q.source !== "dom") {
      round.keys.push(key);
      round.aliased = true;
      console.debug(LOG, "Page shows the question worded differently:", dom.question);
      return null;
    }
    return { ...dom, source: "dom" };
  }

  function startRound(q) {
    if (round) round.cancelled = true; // an older question must not answer for this one
    clearMark();
    const dom = getQuestionDataFromDom();
    if (dom) domGate = textKey(dom.question);
    round = { q, keys: [textKey(q.question)], aliased: false, startedAt: Date.now(), sawButtons: false, over: false, overAt: 0, cancelled: false, pick: undefined };
    roundsStarted++;
    handleQuestion(q, round);
  }

  // Wait this long before answering, so it isn’t instant, but never so long that the timer runs out.
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
        show("—");
        return;
      }

      say(`Asking ${modelName(prefs.model)}${prefs.webSearch ? " + web" : ""}... (${q.source})`, "#f0a500");
      show("—");

      const index = await askWithRetry(q);
      if (r.cancelled) return;
      if (index === null) {
        say("Couldn’t get answer", "#f85149");
        return;
      }
      const answerText = q.answers.find((a) => a.index === index)?.text || "?";
      show(answerText);

      // The question often arrives before its buttons do.
      say("Waiting for the answer buttons...", "#f0a500");
      const button = await waitForButton(q, index, r);
      if (r.cancelled) return;
      if (button < 0) {
        say("Couldn’t find that answer on screen — answer above", "#f85149");
        return;
      }

      r.pick = button;
      syncMark();
      const delay = answerDelay(q, q.source === "dom" ? r.startedAt : Date.now());
      if (prefs.autoAnswer) say(`Answering in ${(delay / 1000).toFixed(1)}s...`, "#f0a500");
      else say("Auto-answer is off — answer above");
      await sleep(delay);
      if (r.cancelled) return;

      // Checked here, after the wait, so flipping the switch while waiting counts.
      if (!prefs.autoAnswer) {
        say("Auto-answer is off — answer above");
        return;
      }

      const result = submitAnswer(index, button);
      if (result === "sent") say("✓ Answered (sent over WebSocket)", "#3fb950");
      else if (result === "nosocket") say("Can’t auto-answer: no open WebSocket (Kahoot may be on HTTP) — answer above", "#f85149");
      else say("Answer buttons were gone — answer above", "#f85149");
    } catch (e) {
      say("Error: " + e.message, "#f85149");
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

  function start() {
    buildUI();
    loop();
  }

  // Document-start means <body> doesn’t exist yet. The hooks above are already live; the panel waits.
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

})();
