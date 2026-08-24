import { apiFetch } from "/common/services/api.js";
import { icons } from "/common/utils/icons.js";
import { showToast } from "/common/utils/toast.js";
import { withLoading } from "/common/utils/async-button.js";
import { confirmDialog } from "/common/design-system/app-modal/app-modal.js";
import "/common/design-system/app-empty-state/app-empty-state.js";
import "/common/design-system/app-skeleton/app-skeleton.js";
import "/common/design-system/app-button/app-button.js";
import "/common/design-system/app-badge/app-badge.js";
import "/common/design-system/app-card/app-card.js";
import "/common/design-system/app-input/app-input.js";
import "/common/design-system/app-search/app-search.js";
import "/common/design-system/app-select/app-select.js";
import "/common/design-system/app-tag/app-tag.js";
import "/common/design-system/app-tabs/app-tabs.js";
import { escAttr, escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';

// your-agents-page.css is <link>ed by the host page, not imported here: a sheet
// pulled in by this module only exists once the module does, which is too late
// to style the static shell the page paints before then (see web/agents.html).

// In MPA mode, your-agents-page.css was <link>ed in the HTML. In SPA mode the
// router lazy-loads this module, so we adopt the sheet here too.
import yourAgentsStyles from './your-agents-page.css' with { type: 'css' };
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into. Nothing imported it, so under the client router the
// gutter was reserved and the nav never upgraded.
import '/common/features/app-module-nav.js';
if (!document.adoptedStyleSheets.includes(yourAgentsStyles)) {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, yourAgentsStyles];
}

function parseImageTag(image) {
  if (!image) return { name: "", version: "" };
  const parts = image.split(":");
  return { name: parts[0] || image, version: parts[1] || "latest" };
}

class YourAgentsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #statusFilter = "all";
  #sortBy = "name";
  #pollTimer = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // The host page owns the shell (web/agents.html) so it paints styled
    // before this module arrives; here we only bind to it and fill the API-fed
    // regions. Fallback for hosts that don't supply it (element created in JS).
    if (!this.querySelector("#agents-grid")) this.insertAdjacentHTML("afterbegin", this.#shell());
    // The deploy dialog stays component-owned: it has no pre-JS footprint, so
    // duplicating it into every host page would buy nothing.
    this.insertAdjacentHTML("beforeend", this.#deployModal());

    // <app-search> owns the clear button and re-fires `input` after clearing,
    // so one listener covers typing and clearing alike.
    this.querySelector("#search-input").addEventListener("input", () => this.#renderGrid());

    this.querySelector("#sort-select").addEventListener("change", (e) => {
      this.#sortBy = e.target.value;
      this.#renderGrid();
    });

    // <app-tabs strip>: the counts are data-driven, so this page renders the
    // buttons and the component owns the tablist semantics and the indicator.
    this.querySelector("#status-tabs").addEventListener("tab-change", (e) => {
      this.#statusFilter = e.detail.key;
      this.#renderTabs();
      this.#renderGrid();
    });

    this.#setupModal();
    this.#load();
  }

  async #load() {
    const result = await call('fetchContainers', "", 1, 100);
    this.#agents = result.data || [];

    // Fetch upload info so we can show upload source (GitHub/Upload) on all
    // agent cards and granular progress for agents still deploying.
    try {
      const res = await apiFetch("/agents/my-uploads");
      if (res.ok) {
        const body = await res.json();
        const uploads = body.data || [];
        const uploadMap = new Map();
        for (const u of uploads) uploadMap.set(u.agent_name, u.upload_info);
        for (const a of this.#agents) {
          a._uploadInfo = uploadMap.get(a.name) || null;
        }
      }
    } catch { /* best-effort */ }

    this.#renderTabs();
    this.#renderGrid();
    this.#schedulePoll();
  }

  #schedulePoll() {
    clearTimeout(this.#pollTimer);
    const hasSettingUp = this.#agents.some(
      (a) => a.status === "deploying" || a.status === "starting",
    );
    if (hasSettingUp) {
      this.#pollTimer = setTimeout(() => this.#pollSettingUp(), 5000);
    }
  }

  async #pollSettingUp() {
    const result = await call('fetchContainers', "", 1, 100);
    const freshAgents = result.data || [];
    const freshMap = new Map();
    for (const a of freshAgents) freshMap.set(a.id, a);

    let tabsChanged = false;
    for (const a of this.#agents) {
      if (a.status !== "deploying" && a.status !== "starting") continue;
      const fresh = freshMap.get(a.id);
      if (!fresh || fresh.status === a.status) continue;
      // Status changed — update in place, preserve upload info
      const uploadInfo = a._uploadInfo;
      Object.assign(a, fresh);
      a._uploadInfo = uploadInfo;
      tabsChanged = true;
      // Re-render only this card
      const card = this.querySelector(`[data-agent-id="${a.id}"]`);
      if (card) {
        const tmp = document.createElement("div");
        tmp.innerHTML = this.#renderCard(a);
        card.replaceWith(tmp.firstElementChild);
      }
    }

    if (tabsChanged) this.#renderTabs();
    this.#schedulePoll();
  }

  #renderCard(a) {
    const name = a.display_name || a.name;
    const isRunning = a.status === "running";
    const isError = a.status === "error" || a.status === "failed";
    const isPending = a.status === "deploying" || a.status === "starting";
    // Status goes straight to <app-card status>, which maps
    // running / error|failed / deploying|starting / else to its status dot —
    // the same mapping this page used to compute for app-card's accent bar.
    const { version: imgVersion } = parseImageTag(a.image);
    const version = a.version || imgVersion;
    const tags = a.tags || [];

    // The card's deploying body is driven by `status`; only the headline is
    // ours, because the live build message is the useful part of it.
    const setupStatus =
      a._uploadInfo?.status_message ||
      (a.status === "starting" ? "Starting container…" : "Agent is being deployed…");

    const sourceType = a._uploadInfo?.upload_type;
    const sourceLabel = sourceType === "github" ? "GitHub" : sourceType === "zip" ? "Zip" : null;

    // Mid-provision: no lifecycle actions. Deploying an agent that is already
    // deploying, or deleting it out from under its own build, both fail.
    const footerButtonsHtml = isPending
      ? ""
      : isRunning
        ? `
        <app-button slot="footer" variant="tertiary" size="sm" icon-only data-action="restart" data-name="${escAttr(a.name)}" aria-label="Restart ${escAttr(name)}" title="Restart">${icons.refresh()}</app-button>
        <app-button slot="footer" variant="tertiary" size="sm" icon-only data-action="stop" data-name="${escAttr(a.name)}" aria-label="Stop ${escAttr(name)}" title="Stop">${icons.square()}</app-button>
        <app-button slot="footer" variant="ghost-danger" size="sm" icon-only class="card-delete" data-action="delete" data-id="${escAttr(a.id)}" data-name="${escAttr(a.name)}" aria-label="Delete ${escAttr(name)}" title="Delete ${escAttr(name)}">${icons.trash()}</app-button>`
        : `
        <app-button slot="footer" variant="primary" size="sm" data-action="deploy" data-id="${escAttr(a.id)}" data-name="${escAttr(a.name)}" data-image="${escAttr(a.image || "")}">${icons.play()} Deploy</app-button>
        <app-button slot="footer" variant="ghost-danger" size="sm" icon-only class="card-delete" data-action="delete" data-id="${escAttr(a.id)}" data-name="${escAttr(a.name)}" aria-label="Delete ${escAttr(name)}" title="Delete ${escAttr(name)}">${icons.trash()}</app-button>`;

    // `status` alone drives the card's status dot and its error/deploying
    // bodies — the page passes the state, the component paints it. The source
    // label is a header action (app-card has no trailing slot; a node in one
    // was dropped on the card's first render).
    return `
    <app-card
      data-agent-id="${escAttr(a.id)}"
      name="${escAttr(name)}"
      ${version ? `version="${escAttr(String(version).replace(/^v/, ""))}"` : ""}
      ${a.status ? `status="${escAttr(a.status)}"` : ""}
      href="/agent-card?id=${escAttr(a.id)}"
      ${isError ? `error-title="Agent failed" error-body="Container exited with an error."` : ""}
      ${isPending ? `deploy-label="${escAttr(setupStatus)}"` : ""}
      ${!isError && !isPending && a.description ? `description="${escAttr(a.description)}"` : ""}
      ${tags.length ? `tags="${escAttr(JSON.stringify(tags))}"` : ""}
    >
      ${sourceLabel ? `<app-badge slot="actions" class="agent-card-source" variant="neutral">${escHtml(sourceLabel)}</app-badge>` : ""}
      ${isError ? `<a slot="footer" data-action="view-logs" href="/flows?agent=${encodeURIComponent(a.id)}" class="error-logs-link">View logs</a>` : ""}
      ${footerButtonsHtml}
    </app-card>
  `;
  }

  disconnectedCallback() {
    clearTimeout(this.#pollTimer);
  }

  #renderTabs() {
    const running = this.#agents.filter((a) => a.status === "running").length;
    const settingUp = this.#agents.filter(
      (a) => a.status === "deploying" || a.status === "starting",
    ).length;
    const failed = this.#agents.filter(
      (a) => a.status === "error" || a.status === "failed",
    ).length;
    const stopped = this.#agents.length - running - settingUp - failed;

    const tab = (key, label, n) =>
      `<button class="tab" type="button" role="tab"
        aria-selected="${this.#statusFilter === key}" data-key="${key}">
        ${label}<span class="n">${n}</span></button>`;

    this.querySelector("#status-tabs").innerHTML =
      tab("all", "All", this.#agents.length) +
      tab("running", "Running", running) +
      tab("setting-up", "Setting up", settingUp) +
      tab("stopped", "Stopped", stopped) +
      tab("failed", "Failed", failed);
  }

  /** Fallback shell — mirrors the static markup in web/agents.html's
   *  your-agents view. */
  #shell() {
    return `
      <app-module-nav module="agents"></app-module-nav>
      <div class="page-header">
        <div class="page-header-top">
          <div>
            <h1 class="title-page">Your agents</h1>
            <p class="page-desc">Deployed agent containers you manage. Track status and failures, then open one to manage access, versions, and settings.</p>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <app-search id="search-input" class="search-wrap" size="md"
          placeholder="Search agents by name, skill, or capability..."
          aria-label="Search agents"></app-search>
        <app-select id="sort-select" class="sort-select" aria-label="Sort agents"
          options='[{"value":"name","label":"Sort: Name"},{"value":"status","label":"Sort: Status"},{"value":"version","label":"Sort: Version"}]'
          value="name">
          <span data-slot="leading">${icons.sortBoth()}</span>
        </app-select>
      </div>
      <app-tabs strip id="status-tabs">${Array.from({ length: 4 }, () => `<div class="skel-tab"></div>`).join("")}</app-tabs>
      <div class="agents-grid" id="agents-grid">${this.#skeletonCards()}</div>
    `;
  }

  #deployModal() {
    return `
      <app-modal id="deploy-modal" heading="Deploy Agent">
        <div class="modal-section">
          <h3>Environment Variables</h3>
          <p>These will be injected into the container. Saved to agent secrets for future deploys.</p>
          <div id="env-rows"></div>
          <div style="display:flex;gap:var(--s-12);margin-top:var(--s-8);">
            <app-button variant="tertiary" size="sm" id="btn-add-env">${icons.plus()} Add variable</app-button>
            <app-button variant="ghost" size="sm" id="btn-import-secrets">${icons.key()} Import from secrets</app-button>
          </div>
        </div>
        <div class="modal-section" id="secrets-import-section" style="display:none;">
          <h3>Select secrets to import</h3>
          <div class="secret-chips" id="secret-chips"></div>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" id="deploy-cancel">Cancel</app-button>
          <app-button variant="primary" id="deploy-confirm">Deploy</app-button>
        </div>
      </app-modal>
    `;
  }

  #skeletonCards() {
    // The skeleton is the same component in its loading state, so the card's
    // geometry has one definition and the two states cannot drift apart.
    return Array.from({ length: 4 }, () => `<app-card loading></app-card>`).join("");
  }

  #renderGrid() {
    const q = (this.querySelector("#search-input")?.value || "").toLowerCase();
    let filtered = this.#agents;

    if (this.#statusFilter !== "all") {
      if (this.#statusFilter === "failed") {
        filtered = filtered.filter(
          (a) => a.status === "error" || a.status === "failed",
        );
      } else if (this.#statusFilter === "running") {
        filtered = filtered.filter((a) => a.status === "running");
      } else if (this.#statusFilter === "setting-up") {
        filtered = filtered.filter(
          (a) => a.status === "deploying" || a.status === "starting",
        );
      } else {
        // "stopped" covers everything that isn't running, setting up, or failed.
        filtered = filtered.filter(
          (a) =>
            a.status !== "running" &&
            a.status !== "deploying" &&
            a.status !== "starting" &&
            a.status !== "error" &&
            a.status !== "failed",
        );
      }
    }

    if (q) {
      filtered = filtered.filter(
        (a) =>
          (a.display_name || a.name || "").toLowerCase().includes(q) ||
          (a.image || "").toLowerCase().includes(q),
      );
    }

    filtered = this.#sortAgents(filtered);

    const grid = this.querySelector("#agents-grid");
    if (!this.#agents.length) {
      grid.innerHTML = `
        <div class="empty-wrap">
          <app-empty-state
            title="No agents deployed"
            description="Deploy your first agent from the catalog or add a new one."
            icon='${icons.layers("", 40)}'>
            <a href="/agents" class="empty-action-link">Browse catalog</a>
            <a href="/add-agent" class="empty-action-link empty-action-link--secondary">Import agent</a>
          </app-empty-state>
        </div>`;
      return;
    }

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="empty-wrap">
          <app-empty-state
            title="No matching agents"
            description="Try adjusting your search or filter criteria."
            icon='${icons.search("", 40)}'>
          </app-empty-state>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map((a) => this.#renderCard(a)).join("");
  }

  #sortAgents(agents) {
    const copy = [...agents];
    if (this.#sortBy === "name") {
      copy.sort((a, b) =>
        (a.display_name || a.name || "").localeCompare(
          b.display_name || b.name || "",
        ),
      );
    } else if (this.#sortBy === "status") {
      const order = { running: 0, deploying: 1, starting: 2, stopped: 3, error: 4, failed: 5 };
      copy.sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
      );
    } else if (this.#sortBy === "version") {
      copy.sort((a, b) =>
        (a.version || "").localeCompare(b.version || ""),
      );
    }
    return copy;
  }

  #setupModal() {
    let deployAgentId = null;
    let deployAgentName = null;
    let deployImage = null;
    let userSecrets = [];
    let selectedSecrets = new Set();

    const modal = this.querySelector("#deploy-modal");
    const envRows = this.querySelector("#env-rows");
    const secretsSection = this.querySelector("#secrets-import-section");
    const secretChips = this.querySelector("#secret-chips");

    const addEnvRow = (key = "", value = "") => {
      const row = document.createElement("div");
      row.className = "env-row";
      row.innerHTML = `<app-input size="sm" placeholder="KEY" aria-label="Variable name" value="${escAttr(key)}"></app-input><app-input size="sm" placeholder="value" aria-label="Variable value" value="${escAttr(value)}"></app-input><app-button class="env-remove" variant="ghost" size="sm" icon-only aria-label="Remove variable">${icons.xCircle()}</app-button>`;
      row.querySelector(".env-remove").addEventListener("click", () => row.remove());
      envRows.appendChild(row);
    };

    this.querySelector("#btn-add-env").addEventListener("click", () =>
      addEnvRow(),
    );

    this.querySelector("#btn-import-secrets").addEventListener(
      "click",
      async () => {
        if (secretsSection.style.display !== "none") {
          secretsSection.style.display = "none";
          return;
        }
        try {
          const res = await apiFetch("/secrets");
          if (!res.ok) throw new Error();
          userSecrets = await res.json();
        } catch {
          userSecrets = [];
        }

        if (!userSecrets.length) {
          showToast("No user secrets found. Add them in Settings.");
          return;
        }

        secretChips.innerHTML = userSecrets
          .map(
            (s) =>
              `<app-tag class="secret-chip" size="sm" selectable data-name="${escAttr(s.name)}">${escHtml(s.name)}</app-tag>`,
          )
          .join("");
        secretsSection.style.display = "";

        // <app-tag selectable> owns its own selected state and keyboard
        // handling; the set below is just which names the deploy will import.
        secretChips.addEventListener("tag-change", (e) => {
          const name = e.target.dataset.name;
          if (e.detail.selected) selectedSecrets.add(name);
          else selectedSecrets.delete(name);
        });
      },
    );

    this.querySelector("#deploy-cancel").addEventListener("click", () =>
      modal.close(),
    );

    const deployBtn = this.querySelector("#deploy-confirm");
    deployBtn.addEventListener(
      "click",
      withLoading(deployBtn, "Deploying...", async () => {
        if (selectedSecrets.size > 0 && deployAgentId) {
          await apiFetch(
            `/agents/${deployAgentId}/secrets/import`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ secret_names: [...selectedSecrets] }),
            },
          );
        }

        const rows = envRows.querySelectorAll(".env-row");
        for (const row of rows) {
          const inputs = row.querySelectorAll("input");
          const key = inputs[0].value.trim();
          const val = inputs[1].value;
          if (!key) continue;
          await apiFetch(`/agents/${deployAgentId}/secrets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: key, value: val }),
          });
        }

        const res = await apiFetch("/containers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: deployImage,
            name: deployAgentName,
          }),
        });
        if (!res.ok) throw new Error(await res.text());

        modal.close();
        this.#load();
        showToast(`Deployed ${deployAgentName}`);
      }),
    );

    this.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const { action } = btn.dataset;

      if (action === "deploy") {
        deployAgentId = btn.dataset.id;
        deployAgentName = btn.dataset.name;
        deployImage = btn.dataset.image;
        envRows.innerHTML = "";
        selectedSecrets.clear();
        secretsSection.style.display = "none";

        try {
          const res = await apiFetch(
            `/agents/${deployAgentId}/secrets`,
          );
          if (res.ok) {
            const secrets = await res.json();
            if (secrets.length) {
              for (const s of secrets) addEnvRow(s.name, "");
            }
          }
        } catch {
          /* no secrets */
        }

        modal.setAttribute("heading", `Deploy ${deployAgentName}`);
        modal.open();
      } else if (action === "restart" || action === "stop") {
        const name = btn.dataset.name;
        // These are fixed-size icon buttons: swapping in a label overflows the
        // square and lands on the card body. <app-button loading> shows its own
        // spinner INSTEAD of the glyph, so lock the card's other lifecycle
        // buttons and let the button draw the busy state.
        const siblings = [...btn.closest(".card-foot").querySelectorAll("[data-action]")];
        for (const b of siblings) b.disabled = true;
        btn.setAttribute("aria-busy", "true");
        btn.toggleAttribute("loading", true);
        try {
          const res = await apiFetch(
            `/containers/${encodeURIComponent(name)}/${action}`,
            { method: "POST" },
          );
          if (!res.ok) throw new Error(await res.text());
          showToast(
            `${action === "restart" ? "Restarted" : "Stopped"} ${name}`,
          );
          await this.#load();
        } catch (err) {
          showToast(`Failed to ${action}: ${err.message}`);
        } finally {
          // #load() usually replaces these nodes; restore anyway so a failed
          // reload can't leave the card stuck on a spinner.
          btn.removeAttribute("aria-busy");
          btn.removeAttribute("loading");
          for (const b of siblings) b.disabled = false;
        }
      } else if (action === "delete") {
        const name = btn.dataset.name;
        const id = btn.dataset.id;
        const confirmed = await confirmDialog({
          title: `Delete ${name}`,
          message: `This will stop the container and remove it from the registry. This action cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) return;
        try {
          const res = await apiFetch(
            `/agents/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          if (!res.ok) throw new Error(await res.text());
          this.#load();
          showToast(`Deleted ${name}`);
        } catch (err) {
          showToast(`Failed to delete: ${err.message}`);
        }
      }
    });
  }

}

customElements.define("your-agents-page", YourAgentsPage);
