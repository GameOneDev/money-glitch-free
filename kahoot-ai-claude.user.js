// ==UserScript==
// @name         Kahoot AI Helper - Claude (HTTP + WebSocket)
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Answers Kahoot questions with Claude. Auto-answers over Kahoot's WebSocket, with a choice of model, optional web search and fast mode, and an optional answer highlight. Reads questions from the WebSocket or HTTP long-polling traffic, and falls back to the page.
// @match        https://kahoot.it/*
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
  // The panel's model menu. The first one is where it starts; after that it remembers.
  const MODELS = [
    { id: "claude-haiku-5-5", name: "Haiku 5.5" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Opus 5.5" },
    // { id: "claude-fable-5-1", name: "Fable 5.1" },
  ];
  // Fast mode (speed: "fast") is a research preview that only some models have, at twice the price.
  const FAST_MODELS = new Set(["claude-opus-5-5"]);
  const FAST_BETA = "fast-mode-2026-02-01";
  // Claude 5.x models think before they answer, and that thinking counts toward max_tokens.
  // So keep the effort low and leave room for it. Use null for models without the effort setting.
  const EFFORT = "low";
  const MAX_TOKENS = 1024;
  // With web search the model also writes its queries, so give it more room, and more time.
  const MAX_TOKENS_SEARCH = 4096;
  const MAX_SEARCHES = 2;
  const MAX_CONTINUATIONS = 3;
  const API_TIMEOUT_MS = 20000;
  const SEARCH_TIMEOUT_MS = 40000;
  // A pause before sending the answer, so it isn't instant. Set both to 0 for the fastest answers.
  const ANSWER_DELAY_MIN = 150;
  const ANSWER_DELAY_MAX = 700;
  // Never wait so long that less than this much of the question's timer is left to answer in.
  const TIMER_MARGIN_MS = 2500;
  // How long to wait for the answer buttons to show up and become clickable.
  const BUTTON_WAIT_MS = 30000;
  // CometD can redeliver a message after a reconnect. A question matching the one that just finished,
  // arriving this soon after, is that and not a new question.
  const REPEAT_WINDOW_MS = 10000;
  // Print Kahoot's game messages (both directions) in the console, for working out why an answer
  // isn't taken.
  const TRACE = false;

  const LOG = "[Kahoot AI]";
  const API_URL = "https://api.anthropic.com/v1/messages";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── PANEL SETTINGS ────────────────────────────────────────────
  // What the panel's switches and menu hold. Saved in this browser, so they stick between games.
  const PREFS = {
    autoAnswer: { key: "kahoot-ai-auto-answer", fallback: true },   // send Claude's answer for you
    highlight:  { key: "kahoot-ai-highlight",   fallback: true },   // outline the answer on screen
    webSearch:  { key: "kahoot-ai-web-search",  fallback: false },  // let Claude search the web
    fast:       { key: "kahoot-ai-fast",        fallback: false },  // speed: "fast"
    model:      { key: "kahoot-ai-model",       fallback: MODELS[0].id },
  };
  const prefs = {};
  for (const [name, { key, fallback }] of Object.entries(PREFS)) {
    prefs[name] = fallback;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) prefs[name] = typeof fallback === "boolean" ? saved === "1" : saved;
    } catch (_) {}
  }
  if (!MODELS.some((m) => m.id === prefs.model)) prefs.model = PREFS.model.fallback;

  function setPref(name, value) {
    prefs[name] = value;
    try { localStorage.setItem(PREFS[name].key, typeof value === "boolean" ? (value ? "1" : "0") : value); } catch (_) {}
    renderControls();
    if (name === "highlight") syncMark();
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

  function saveApiKey(value) {
    apiKey = value;
    editingKey = false;
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
    if (!TRACE || !item?.channel || item.channel.startsWith("/meta/")) return;
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
  const buttonFor = (index) => document.querySelector(`[data-functional-selector="answer-${index}"]`);
  const choiceTextEl = (index) => document.querySelector(`[data-functional-selector="question-choice-text-${index}"]`);

  function getQuestionDataFromDom() {
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

  async function askClaude(data) {
    if (!apiKey) {
      const error = new Error('No API key — paste it in the panel');
      error.fatal = true;
      throw error;
    }
    const search = prefs.webSearch;
    let fast = prefs.fast && fastModel();
    const answersText = data.answers.map((a) => `${a.index}: ${a.text}`).join('\n');
    const validNumbers = data.answers.map((a) => a.index).join(', ');
    const prompt = `You are answering a quiz question. ${search ? 'If you are not sure of the answer you may search the web, but answer straight away when you know it. ' : ''}Reply with ONLY the number of the correct answer (${validNumbers}). No explanation, no punctuation, just the number.

Question: ${data.question}

Answers:
${answersText}`;

    const body = {
      model: prefs.model,
      max_tokens: search ? MAX_TOKENS_SEARCH : MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    };
    if (EFFORT) body.output_config = { effort: EFFORT };
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }];
    const timeoutMs = search ? SEARCH_TIMEOUT_MS : API_TIMEOUT_MS;

    let json;
    for (let step = 0; ; step++) {
      let { response, json: reply } = await callApi(body, fast, timeoutMs);
      // Fast mode has its own rate limit, and not every account has it. Use normal speed instead.
      if (fast && (response.status === 429 || (response.status === 400 && /speed|fast/i.test(reply.error?.message ?? '')))) {
        console.log(LOG, 'Fast mode was refused, using normal speed:', reply.error?.message ?? `HTTP ${response.status}`);
        fast = false;
        ({ response, json: reply } = await callApi(body, false, timeoutMs));
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

    // The last whole number that is one of the answers, so a "2007" in its words can't be mistaken for one.
    const numbers = (text.match(/\b\d+\b/g) || []).map(Number).filter((n) => data.answers.some((a) => a.index === n));
    return numbers.length ? numbers[numbers.length - 1] : null;
  }

  // One retry, since a single hiccup shouldn't cost the question. A bad key won't fix itself,
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
  // the page when it's there, else by position. -1 when the buttons aren't there yet, or when the page
  // shows other answers (an older question's screen).
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
  // answers. That's also the sign the question is live. If it never enables, return the button anyway.
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

  // ── ANSWER HIGHLIGHT ──────────────────────────────────────────
  // A soft outline over the answer Claude picked. Drawn over the page, not in it, so Kahoot
  // re-rendering can't remove it, and it follows the button until the question screen goes away.
  let mark = null; // { chosen, el }

  function showMark(chosen) {
    if (mark?.chosen === chosen) return;
    clearMark();
    const el = document.createElement('div');
    el.className = 'kahoot-ai-ring';
    document.body.appendChild(el);
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
  function setStatus(text, color) {
    const el = document.getElementById('kahoot-status');
    if (el) { el.textContent = text; el.style.color = color || '#8b949e'; }
  }

  function setAnswer(text, color) {
    const el = document.getElementById('kahoot-answer');
    if (el) { el.textContent = text; el.style.color = color || '#3fb950'; }
  }

  const SWITCHES = [
    { name: 'autoAnswer', label: 'Auto-answer', title: "On: sends Claude's answer for you. Off: only shows it here." },
    { name: 'highlight', label: 'Highlight answer', title: "Outlines the answer Claude picks on the page." },
    { name: 'webSearch', label: 'Web search', title: "Lets Claude search the web when it isn't sure. Slower, and each search is billed." },
    { name: 'fast', label: 'Fast mode', title: "Asks for faster output (speed: fast). Only on Opus 5.5, at twice the price." },
  ];

  function renderControls() {
    for (const { name } of SWITCHES) {
      const sw = document.getElementById(`kahoot-sw-${name}`);
      if (!sw) continue;
      const on = prefs[name];
      const disabled = name === 'fast' && !fastModel();
      sw.setAttribute('aria-checked', String(on));
      sw.setAttribute('aria-disabled', String(disabled));
      sw.style.background = on ? '#238636' : '#30363d';
      sw.style.opacity = disabled ? '.4' : '1';
      sw.style.cursor = disabled ? 'not-allowed' : 'pointer';
      sw.firstElementChild.style.left = on ? '18px' : '2px';
    }
    const select = document.getElementById('kahoot-model');
    if (select) select.value = prefs.model;
  }

  // The key row: when there's a key it shows just "saved" with change / remove, and the box to paste
  // one stays out of the way until asked for.
  function renderKey() {
    const state = document.getElementById('kahoot-key-state');
    if (!state) return;
    state.textContent = apiKey ? '✓ saved' : 'not set';
    state.style.color = apiKey ? '#3fb950' : '#f85149';
    for (const id of ['kahoot-key-change', 'kahoot-key-remove']) {
      document.getElementById(id).style.display = apiKey ? '' : 'none';
    }
    document.getElementById('kahoot-key-editor').style.display = !apiKey || editingKey ? 'flex' : 'none';
  }

  function submitKey() {
    const input = document.getElementById('kahoot-key');
    const value = input.value.trim();
    if (!KEY_SHAPE.test(value)) {
      setStatus("That doesn't look like an Anthropic API key (sk-ant-…)", '#f85149');
      return;
    }
    input.value = '';
    saveApiKey(value);
    setStatus('API key saved', '#3fb950');
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .kahoot-ai-ring {
        position: fixed; z-index: 999998; pointer-events: none; box-sizing: border-box; border-radius: 12px;
        border: 2px solid rgba(63, 185, 80, .45); background: rgba(63, 185, 80, .12);
      }
    `;
    document.head.appendChild(style);
  }

  function buildUI() {
    injectStyles();
    const reopenBtn = document.createElement('div');
    reopenBtn.id = 'kahoot-reopen';
    reopenBtn.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      width: 32px; height: 32px; border-radius: 50%;
      background: #58a6ff; color: #0f1117;
      font-size: 18px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    `;
    reopenBtn.textContent = '⚡';
    document.body.appendChild(reopenBtn);

    const panel = document.createElement('div');
    panel.id = 'kahoot-ai-panel';
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      background: #0f1117; color: #e2e8f0;
      border: 1px solid #30363d; border-radius: 12px;
      padding: 16px 20px; font-family: 'Fira Code', monospace;
      font-size: 13px; min-width: 240px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    `;
    const row = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    const link = 'background:none;border:none;color:#58a6ff;cursor:pointer;font:inherit;font-size:11px;padding:0 0 0 6px;';
    panel.innerHTML = `
      <div style="${row}margin-bottom:14px;">
        <span style="font-size:14px;font-weight:700;color:#58a6ff;">⚡ Kahoot Helper</span>
        <button id="kahoot-close" style="
          background:none;border:none;color:#8b949e;
          cursor:pointer;font-size:18px;padding:0;line-height:1;">×</button>
      </div>
      <div style="${row}margin-bottom:6px;">
        <span style="font-size:12px;">API key</span>
        <span>
          <span id="kahoot-key-state" style="font-size:11px;"></span>
          <button id="kahoot-key-change" type="button" style="${link}">change</button>
          <button id="kahoot-key-remove" type="button" style="${link}">remove</button>
        </span>
      </div>
      <div id="kahoot-key-editor" style="display:flex;gap:6px;margin-bottom:10px;">
        <input id="kahoot-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-..."
          style="flex:1;min-width:0;background:#161b22;color:#e2e8f0;border:1px solid #30363d;
          border-radius:6px;padding:4px 6px;font:inherit;font-size:12px;">
        <button id="kahoot-key-save" type="button" style="background:#238636;color:#fff;border:none;
          border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;">Save</button>
      </div>
      <div style="${row}">
        <span style="font-size:12px;">Model</span>
        <select id="kahoot-model" style="background:#161b22;color:#e2e8f0;border:1px solid #30363d;
          border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;">
          ${MODELS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}
        </select>
      </div>
      ${SWITCHES.map(({ name, label, title }) => `
        <div style="${row}" title="${title}">
          <span style="font-size:12px;">${label}</span>
          <button id="kahoot-sw-${name}" type="button" role="switch" aria-label="${label}"
            style="position:relative;width:36px;height:20px;border:none;border-radius:10px;
            padding:0;transition:background .15s;">
            <span style="position:absolute;top:2px;left:2px;width:16px;height:16px;
              border-radius:50%;background:#e2e8f0;transition:left .15s;"></span>
          </button>
        </div>`).join('')}
      <div style="font-size:10px;color:#8b949e;text-transform:uppercase;
        letter-spacing:0.08em;margin:14px 0 4px;">Status</div>
      <div id="kahoot-status" style="font-size:12px;color:#8b949e;margin-bottom:12px;">
        Waiting for question...
      </div>
      <div style="font-size:10px;color:#8b949e;text-transform:uppercase;
        letter-spacing:0.08em;margin-bottom:4px;">Answer</div>
      <div id="kahoot-answer" style="
        font-size:18px;font-weight:700;color:#3fb950;
        min-height:26px;letter-spacing:0.02em;">—</div>
    `;
    document.body.appendChild(panel);

    for (const { name } of SWITCHES) {
      document.getElementById(`kahoot-sw-${name}`).addEventListener('click', (e) => {
        if (e.currentTarget.getAttribute('aria-disabled') === 'true') return;
        setPref(name, !prefs[name]);
      });
    }
    document.getElementById('kahoot-model').addEventListener('change', (e) => setPref('model', e.target.value));
    renderControls();

    const keyInput = document.getElementById('kahoot-key');
    // Keep Kahoot's own keyboard handling away from what's typed here.
    for (const type of ['keydown', 'keyup', 'keypress']) keyInput.addEventListener(type, (e) => e.stopPropagation());
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });
    document.getElementById('kahoot-key-save').addEventListener('click', submitKey);
    document.getElementById('kahoot-key-change').addEventListener('click', () => {
      editingKey = !editingKey;
      renderKey();
      if (editingKey) keyInput.focus();
    });
    document.getElementById('kahoot-key-remove').addEventListener('click', () => {
      saveApiKey('');
      setStatus('API key removed');
    });
    renderKey();

    document.getElementById('kahoot-close').addEventListener('click', () => {
      panel.style.display = 'none';
      reopenBtn.style.display = 'flex';
    });

    reopenBtn.addEventListener('click', () => {
      panel.style.display = '';
      reopenBtn.style.display = 'none';
    });
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
      console.debug(LOG, 'Same question again, not asking twice:', wire.question);
    }

    const dom = getQuestionDataFromDom();
    if (!dom) { domGate = null; return null; }
    const key = textKey(dom.question);
    if (domGate && sameText(domGate, key)) return null;
    domGate = key;
    if (isRepeat(dom.question)) return null;
    // The open round came from the wire and this is the first question the page shows: it's that
    // question, worded differently. (A stale one from before the round began is held by domGate.)
    if (round && !round.over && !round.aliased && round.q.source !== 'dom') {
      round.keys.push(key);
      round.aliased = true;
      console.debug(LOG, 'Page shows the question worded differently:', dom.question);
      return null;
    }
    return { ...dom, source: 'dom' };
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

  // Wait this long before answering, so it isn't instant, but never so long that the timer runs out.
  function answerDelay(q, since) {
    const wanted = ANSWER_DELAY_MIN + Math.random() * (ANSWER_DELAY_MAX - ANSWER_DELAY_MIN);
    if (!q.time) return wanted;
    return Math.max(0, Math.min(wanted, q.time - TIMER_MARGIN_MS - (Date.now() - since)));
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

      say(`Asking ${modelName(prefs.model)}${prefs.webSearch ? ' + web' : ''}... (${q.source})`, '#f0a500');
      show('—');

      const index = await askWithRetry(q);
      if (r.cancelled) return;
      if (index === null) {
        say("Couldn't get answer", '#f85149');
        return;
      }
      const answerText = q.answers.find((a) => a.index === index)?.text || '?';
      show(answerText);

      // The question often arrives before its buttons do.
      say('Waiting for the answer buttons...', '#f0a500');
      const button = await waitForButton(q, index, r);
      if (r.cancelled) return;
      if (button < 0) {
        say("Couldn't find that answer on screen — answer above", '#f85149');
        return;
      }

      r.pick = button;
      syncMark();
      const delay = answerDelay(q, q.source === 'dom' ? r.startedAt : Date.now());
      if (prefs.autoAnswer) say(`Answering in ${Math.round(delay / 1000)}s...`, '#f0a500');
      else say('Auto-answer is off — answer above');
      await sleep(delay);
      if (r.cancelled) return;

      // Checked here, after the wait, so flipping the switch while waiting counts.
      if (!prefs.autoAnswer) {
        say('Auto-answer is off — answer above');
        return;
      }

      const result = submitAnswer(index, button);
      if (result === 'sent') say('✓ Answered (sent over WebSocket)', '#3fb950');
      else if (result === 'nosocket') say("Can't auto-answer: no open WebSocket (Kahoot may be on HTTP) — answer above", '#f85149');
      else say('Answer buttons were gone — answer above', '#f85149');
    } catch (e) {
      say('Error: ' + e.message, '#f85149');
    }
  }

  function loop() {
    try {
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

  // Document-start means <body> doesn't exist yet. The hooks above are already live; the panel waits.
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

})();
