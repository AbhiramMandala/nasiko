/**
 * The chat composer: an auto-growing textarea with voice recording, file
 * attachment, and submit-on-Enter. Used by the orchestrator and chat pages, and
 * demoed on the design-system page.
 *
 * @element app-chatbox
 * @attr {string} placeholder - Textarea placeholder text
 * @attr {boolean} no-attachments - Hide the file attachment button
 * @attr {string} submit-label - Text on the submit button; without it the button
 *   is the round arrow icon. Used where the composer's action needs naming
 *   ("Generate plan") rather than being a generic send.
 * @attr {string} transcription-callback - Name of a data-source function returning transcribed text
 * @attr {string} aria-label - Accessible name for the message box (default: `Message`).
 *   A placeholder is not a name: it is announced inconsistently and disappears
 *   the moment someone starts typing. Every button in here was labelled and the
 *   textarea itself was not.
 * @prop {string} value - Get/set the textarea value
 * @method focus - Put the caret in the composer. Pages that prefill the box
 *   (a suggested-prompt chip, a retry) set `value` then call this — before it
 *   existed, chat-page reached in for the private `#textarea` to focus it.
 * @fires chatbox-submit - User submits; `detail: { value: string, files: [] }` — bubbles.
 *   The box goes into its loading state on submit; the owner calls
 *   `setLoading(false)` (or `setLoading(true)` then false) when the reply lands.
 * @note Keyboard: Enter submits, Shift+Enter newlines, F8 / Alt+R toggles
 *       recording, `/` focuses the box from anywhere on the page.
 */
import { VoiceRecorder } from '../../utils/voice-utils.js';
import { icons } from '../../utils/icons.js';
import { showToast } from '../../utils/toast.js';
import { resolveOptional } from '../../core/data-sources.js';
import { escAttr, escHtml } from '../../utils/escape.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-chatbox.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppChatbox extends HTMLElement {
  #loading = false;
  #initialized = false;
  constructor() {
    super();
    this.voiceRecorder = new VoiceRecorder();
    this.attachedFiles = [];
    this.timerInterval = null;
    this.startTime = null;
    this.maxFileSize = 10 * 1024 * 1024;
  }

  #handleDocumentKeyDown = (e) => {
    const isR = e.key.toLowerCase() === "r" || e.code === "KeyR";
    if (e.key === "F8" || (e.altKey && isR)) {
      e.preventDefault();
      this.toggleRecording();
    }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        this.textarea.focus();
      }
    }
  };

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.render();
      this.cacheElements();
      this.setupListeners();
      this.setState("idle");

      const callbackName = this.getAttribute("transcription-callback");
      if (callbackName) {
        const fn = resolveOptional(callbackName);
        if (fn) this.voiceRecorder.setTranscriptionCallback(fn);
      }
    }
    // Re-added on every connect because disconnect removes it — a moved composer
    // must keep its `/`-to-focus and recording shortcuts. Guarded above instead
    // would lose them permanently on the first re-parenting. (Rebuilding the DOM
    // on reconnect was also wiping whatever draft the user had typed.)
    document.addEventListener("keydown", this.#handleDocumentKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#handleDocumentKeyDown);
    clearInterval(this.timerInterval);
  }

  // `no-attachments` is listed but not reacted to: it is read once at render.
  // The catalog generator requires every documented attribute to appear here,
  // and it is read with hasAttribute rather than getAttribute, which is the
  // form its phantom-attribute check looks for.
  static get observedAttributes() {
    return ["placeholder", "no-attachments", "submit-label"];
  }

  /**
   * The composer's prompt is state, not just markup: a page changes it to say
   * what the box is for right now ("Approve or reject to continue here" while a
   * human-in-the-loop card is waiting). `render()` only runs once, on first
   * connect, so a later attribute write would otherwise be silently ignored.
   */
  attributeChangedCallback(name, previous, value) {
    if (previous === value || !this.textarea) return;
    if (name === "placeholder") this.textarea.placeholder = value || "Type your message...";
    // The label is state as much as the placeholder is: the create-workflow
    // composer flips it from "Generate plan" to "Regenerate plan" once a plan
    // exists, and render() only ever runs on first connect.
    if (name === "submit-label" && this.submitBtn) this.#renderSubmit();
  }

  render() {
    const noAttach = this.hasAttribute("no-attachments");
    const placeholder = this.getAttribute("placeholder") || "Type your message...";
    const ariaLabel = this.getAttribute("aria-label") || "Message";

    this.innerHTML = `
      <form class="chatbox">
        <div class="input-area" id="inputWrapper">
          <textarea
            class="textarea"
            id="textarea"
            rows="1"
            placeholder="${escAttr(placeholder)}"
            aria-label="${escAttr(ariaLabel)}"
          ></textarea>

          ${noAttach ? "" : `
          <button type="button" class="attach-btn" id="dropZone" title="Attach files" aria-label="Attach files">
            ${icons.paperclip("btn-icon", 16)}
          </button>
          <input type="file" id="fileInput" multiple hidden>`}

          <!-- One row, not three absolutely-positioned buttons: the submit button
               is a pill as soon as it carries a label, and the mic and the
               recording timer used to be pinned to its icon-sized width. -->
          <div class="actions">
            <div class="timer" id="timer">
              <span class="rec-dot" aria-hidden="true">●</span>
              <span id="timerText">0.0s</span>
            </div>

            <button type="button" class="record-btn" id="recordBtn"
              aria-label="Start recording">
              ${this.getMicIcon()}
            </button>

            <button type="submit" class="submit-icon" id="submitBtn"></button>
          </div>
        </div>

        ${noAttach ? "" : `<div class="footer"><div class="file-list" id="fileList"></div></div>`}
      </form>
    `;
  }

  /** The submit button's face: a named pill when `submit-label` is set, else the arrow. */
  #renderSubmit() {
    const label = this.getAttribute("submit-label");
    const btn = this.submitBtn;
    btn.classList.toggle("has-label", !!label);
    btn.title = label ? `${label} (Enter)` : "Send (Enter)";
    btn.setAttribute("aria-label", label || "Send message");
    btn.innerHTML = label
      ? `<span>${escHtml(label)}</span>${icons.sparkles("btn-icon", 14)}`
      : icons.arrowUp("btn-icon", 14);
  }

  /** Submit already no-ops on an empty box — say so in the button instead of on click. */
  #syncSubmit() {
    if (this.#loading) return;
    this.submitBtn.disabled = !this.textarea.value.trim() && this.attachedFiles.length === 0;
  }

  cacheElements() {
    this.wrapper = this.querySelector("#inputWrapper");
    this.textarea = this.querySelector("#textarea");
    this.recordBtn = this.querySelector("#recordBtn");
    this.timerEl = this.querySelector("#timer");
    this.timerText = this.querySelector("#timerText");
    this.fileList = this.querySelector("#fileList");
    this.dropZone = this.querySelector("#dropZone");
    this.fileInput = this.querySelector("#fileInput");
    this.submitBtn = this.querySelector("#submitBtn");
  }

  setupListeners() {
    this.#renderSubmit();
    this.#syncSubmit();
    this.textarea.addEventListener("input", () => this.#syncSubmit());
    // Was an inline onsubmit="return false" — same behaviour, minus the inline
    // handler (the one kind of script a strict CSP cannot allow).
    this.querySelector("form")?.addEventListener("submit", (e) => e.preventDefault());
    this.recordBtn.addEventListener("click", () => this.toggleRecording());
    this.submitBtn.addEventListener("click", () => this.handleSubmit());

    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.handleSubmit();
      }
    });

    this.dropZone?.addEventListener("click", () => this.fileInput.click());
    this.fileInput?.addEventListener("change", (e) => this.handleFiles(e.target.files));

    ["dragenter", "dragover"].forEach((name) => {
      this.wrapper?.addEventListener(name, (e) => {
        e.preventDefault();
        this.wrapper.classList.add("drag-over");
      });
    });
    ["dragleave", "drop"].forEach((name) => {
      this.wrapper?.addEventListener(name, (e) => {
        e.preventDefault();
        this.wrapper.classList.remove("drag-over");
      });
    });
    this.wrapper?.addEventListener("drop", (e) => this.handleFiles(e.dataTransfer.files));
  }

  setState(state) {
    this.#loading = state === "loading";
    this.wrapper.dataset.state = state;
    this.recordBtn.dataset.state = state;

    switch (state) {
      case "idle":
        this.recordBtn.disabled = false;
        this.recordBtn.innerHTML = this.getMicIcon();
        this.recordBtn.title = "Start Recording (F8 or Alt+R)";
        this.recordBtn.setAttribute("aria-label", "Start recording");
        this.timerEl.classList.remove("visible");
        this.submitBtn.disabled = false;
        this.#syncSubmit();
        break;
      case "recording":
        this.recordBtn.innerHTML = this.getStopIcon();
        this.recordBtn.title = "Stop Recording (F8)";
        this.recordBtn.setAttribute("aria-label", "Stop recording");
        this.timerEl.classList.add("visible");
        this.startTimer();
        break;
      case "transcribing":
        this.recordBtn.disabled = true;
        this.recordBtn.innerHTML = `<div class="spinner"></div>`;
        this.timerEl.classList.add("visible");
        this.stopTimer(false);
        break;
      case "loading":
        this.submitBtn.disabled = true;
        this.recordBtn.disabled = true;
        this.timerEl.classList.remove("visible");
        break;
    }
  }

  async toggleRecording() {
    if (this.voiceRecorder.isRecording) {
      this.setState("transcribing");
      try {
        const text = await this.voiceRecorder.stopRecording();
        if (text) this.insertText(text);
      } catch (err) {
        showToast(err.message);
      } finally {
        this.setState("idle");
      }
    } else {
      try {
        await this.voiceRecorder.startRecording();
        this.setState("recording");
      } catch (err) {
        // startRecording's messages already name the cause (insecure origin,
        // denied permission, no device) — don't bury them behind a prefix.
        showToast(err.message);
      }
    }
  }

  handleSubmit() {
    if (this.#loading) return;
    const query = this.textarea.value.trim();
    if (!query && this.attachedFiles.length === 0) return;
    const files = [...this.attachedFiles];
    this.setState("loading");
    this.dispatchEvent(
      new CustomEvent("chatbox-submit", {
        bubbles: true,
        detail: { value: query, files },
      }),
    );
  }

  setLoading(isLoading) {
    this.setState(isLoading ? "loading" : "idle");
  }

  reset() {
    this.textarea.value = "";
    this.attachedFiles = [];
    this.renderFiles();
  }

  insertText(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const current = this.textarea.value;
    const before = current.substring(0, start);
    const after = current.substring(end);
    const spacing = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    this.textarea.value = before + spacing + text + after;
    const newPos = start + spacing.length + text.length;
    this.textarea.focus();
    this.textarea.setSelectionRange(newPos, newPos);
  }

  startTimer() {
    this.startTime = Date.now();
    this.timerText.innerText = "0.0s";
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      const diff = (Date.now() - this.startTime) / 1000;
      this.timerText.innerText = diff.toFixed(1) + "s";
    }, 100);
  }

  stopTimer(reset = true) {
    clearInterval(this.timerInterval);
    if (reset) this.timerText.innerText = "0.0s";
  }

  handleFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      if (file.size > this.maxFileSize) {
        showToast(`File too large: ${file.name}`);
        return;
      }
      this.attachedFiles.push({
        id: Math.random().toString(36).slice(2),
        file,
        name: file.name,
        size: file.size,
        type: file.type,
      });
    });
    this.renderFiles();
  }

  renderFiles() {
    this.#syncSubmit();
    if (!this.fileList) return;
    this.fileList.innerHTML = this.attachedFiles.map((f) => `
      <div class="file-item">
        <span>${escHtml(f.name)} (${(f.size / 1024).toFixed(1)}KB)</span>
        <button class="file-remove" data-id="${f.id}" title="Remove file" aria-label="Remove file">
          ${icons.x("", 14)}
        </button>
      </div>
    `).join("");

    this.querySelectorAll(".file-remove").forEach((btn) => {
      btn.onclick = () => this.removeFile(btn.dataset.id);
    });
  }

  removeFile(id) {
    this.attachedFiles = this.attachedFiles.filter((f) => f.id !== id);
    this.renderFiles();
  }

  getMicIcon() {
    return icons.mic("btn-icon", 18);
  }

  getStopIcon() {
    return icons.square("btn-icon", 12);
  }

  /** @override — the host is not focusable, so forward to the real control. */
  focus(options) {
    this.textarea?.focus(options);
  }

  get value() {
    return this.textarea.value;
  }
  set value(val) {
    this.textarea.value = val;
    this.#syncSubmit();
  }
}

customElements.define("app-chatbox", AppChatbox);
