// Lyrbot: the floating help assistant, as on Lyrshop, Lyrtrip and Lyrsoft. A robot button opens a chat window
// answered by the account API's POST /public/lyrbot, with quick questions and WhatsApp/email contact for a human.
// The chat lasts for the browser tab.
import { ACCOUNT_API_BASE } from './auth.js';

{
  const STORAGE_KEY = "lyrbotChat";
  const WHATSAPP_URL = "https://wa.me/16615809465";
  const WHATSAPP_LABEL = "+1 661 580 9465";
  const SUPPORT_EMAIL = "hello@lyrcloud.com";
  const GREETING = "Hi, I'm Lyrbot! Ask me about Lyrcloud's products, plans, or getting your site on the edge.";
  const QUICK_QUESTIONS = ["Is the Launch plan free?", "Which plan should I pick?", "What are Edge Functions?", "How do I get started?"];

  const ROBOT_ICON = `
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <line x1="16" y1="3" x2="16" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <circle cx="16" cy="3" r="1.8" fill="currentColor" />
      <rect x="6" y="8" width="20" height="16" rx="5" fill="currentColor" />
      <rect x="2.5" y="13" width="3" height="6" rx="1.5" fill="currentColor" />
      <rect x="26.5" y="13" width="3" height="6" rx="1.5" fill="currentColor" />
      <circle class="lyrbot-eye" cx="12" cy="15.5" r="2.2" />
      <circle class="lyrbot-eye" cx="20" cy="15.5" r="2.2" />
      <path class="lyrbot-mouth" d="M12 20.2q4 2.6 8 0" fill="none" stroke-width="1.8" stroke-linecap="round" />
      <rect x="11" y="25" width="10" height="4" rx="2" fill="currentColor" />
    </svg>`;
  const WHATSAPP_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3Z"/></svg>`;

  function escapeText(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  // Escape the reply, then turn links, emails and the WhatsApp number into anchors.
  function formatReply(text) {
    return escapeText(text)
      .replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(lyrcloud\.com(?:\/[\w-]+)*\/?(?:#[\w-]+)?)/g, '$1<a href="https://$2">$2</a>')
      .replace(/\b([\w.+-]+@[\w-]+\.[\w.-]*\w)\b/g, '<a href="mailto:$1">$1</a>')
      .replace(/(\+1[\s-]?661[\s-]?580[\s-]?9465)/g, `<a href="${WHATSAPP_URL}" target="_blank" rel="noopener">$1</a>`)
      .replace(/\n/g, "<br />");
  }

  function readHistory() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-30)));
    } catch {
      // Private browsing can block storage; the chat still works for this page view.
    }
  }

  const root = document.createElement("div");
  root.className = "lyrbot";
  root.innerHTML = `
    <button type="button" class="lyrbot-toggle" aria-expanded="false" aria-controls="lyrbot-panel" aria-label="Open Lyrbot, AI assistant">
      ${ROBOT_ICON}
      <span class="lyrbot-toggle-label">Lyrbot</span>
    </button>
    <section class="lyrbot-panel" id="lyrbot-panel" role="dialog" aria-label="Lyrbot AI assistant" hidden>
      <header class="lyrbot-header">
        <span class="lyrbot-avatar">${ROBOT_ICON}</span>
        <div>
          <strong>Lyrbot</strong>
          <small>AI assistant · replies in seconds</small>
        </div>
        <button type="button" class="lyrbot-close" aria-label="Close Lyrbot">&times;</button>
      </header>
      <div class="lyrbot-messages" aria-live="polite"></div>
      <div class="lyrbot-quick" aria-label="Suggested questions"></div>
      <form class="lyrbot-form">
        <input type="text" class="lyrbot-input" maxlength="1000" placeholder="Ask Lyrbot a question…" aria-label="Your question" autocomplete="off" />
        <button type="submit" class="lyrbot-send" aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.6 2-12.6 2z"/></svg>
        </button>
      </form>
      <div class="lyrbot-contact">
        <span>Prefer a person?</span>
        <a class="lyrbot-whatsapp" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${WHATSAPP_ICON} WhatsApp ${WHATSAPP_LABEL}</a>
        <a class="lyrbot-email" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
        <a class="lyrbot-lyrchat" href="https://lyrsoft.com/chat/#/new?to=support&site=Lyrcloud" target="_blank" rel="noopener">💬 Lyr Chat</a>
      </div>
    </section>`;
  document.body.appendChild(root);

  const toggle = root.querySelector(".lyrbot-toggle");
  const panel = root.querySelector(".lyrbot-panel");
  const messages = root.querySelector(".lyrbot-messages");
  const quick = root.querySelector(".lyrbot-quick");
  const form = root.querySelector(".lyrbot-form");
  const input = root.querySelector(".lyrbot-input");
  const send = root.querySelector(".lyrbot-send");
  let history = readHistory();
  let busy = false;

  function bubble(role, html) {
    const item = document.createElement("div");
    item.className = `lyrbot-message is-${role}`;
    item.innerHTML = html;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  }

  function render() {
    messages.innerHTML = "";
    bubble("bot", formatReply(GREETING));
    history.forEach((entry) => bubble(entry.role === "user" ? "user" : "bot", entry.role === "user" ? escapeText(entry.content) : formatReply(entry.content)));
    quick.hidden = history.length > 0;
    quick.innerHTML = QUICK_QUESTIONS.map((question) => `<button type="button" data-question="${escapeText(question)}">${escapeText(question)}</button>`).join("");
  }

  async function ask(question) {
    const text = question.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    quick.hidden = true;
    history.push({ role: "user", content: text });
    saveHistory(history);
    bubble("user", escapeText(text));
    const typing = bubble("bot", '<span class="lyrbot-typing" aria-label="Lyrbot is typing"><i></i><i></i><i></i></span>');
    try {
      const res = await fetch(`${ACCOUNT_API_BASE}/public/lyrbot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const isJson = (res.headers.get("Content-Type") || "").includes("application/json");
      const data = isJson ? await res.json() : {};
      if (!res.ok || !data.reply) throw new Error(data.error || "");
      history.push({ role: "assistant", content: data.reply });
      saveHistory(history);
      typing.innerHTML = formatReply(data.reply);
    } catch (error) {
      // Drop the unanswered question so a retry doesn't send it twice.
      history.pop();
      saveHistory(history);
      typing.classList.add("is-error");
      typing.innerHTML = formatReply(error.message
        || `I couldn't connect just now. You can reach our team on WhatsApp ${WHATSAPP_LABEL} or at ${SUPPORT_EMAIL}.`);
    } finally {
      busy = false;
      send.disabled = false;
      messages.scrollTop = messages.scrollHeight;
      input.focus();
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    root.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close Lyrbot" : "Open Lyrbot, AI assistant");
    if (open) {
      render();
      input.focus();
    } else {
      toggle.focus();
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  root.querySelector(".lyrbot-close").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) setOpen(false);
  });
  quick.addEventListener("click", (event) => {
    const button = event.target.closest("[data-question]");
    if (button) ask(button.dataset.question);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = "";
    ask(text);
  });
}
