

const MAX_LENGTH = 2000;

// ── Wire up textarea: character counter + keyboard shortcut ──────────────────

const textarea = document.getElementById("message-input");
const charCount = document.getElementById("char-count");
const sendBtn = document.getElementById("send-btn");

textarea.addEventListener("input", () => {
  const len = textarea.value.length;
  charCount.textContent = `${len} / ${MAX_LENGTH}`;
  charCount.className = "char-count";
  if (len > MAX_LENGTH * 0.9) charCount.classList.add("warn");
  if (len >= MAX_LENGTH) charCount.classList.add("error");
});

textarea.addEventListener("keydown", (e) => {
  // Enter = send, Shift+Enter = newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Main send function ────────────────────────────────────────────────────────

async function sendMessage() {
  const message = textarea.value.trim();
  if (!message) return;

  setLoading(true);

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    const data = await response.json();

    if (!response.ok) {
      // FastAPI validation error or rate limit
      const detail = data.detail;
      const msg = Array.isArray(detail)
        ? detail.map(d => d.msg).join(", ")
        : (detail || `Error ${response.status}`);
      showError(msg);
      return;
    }

    renderResults(data);

  } catch (err) {
    showError("Network error: " + err.message);
  } finally {
    setLoading(false);
  }
}

// ── Render all pipeline stages ────────────────────────────────────────────────

function renderResults(data) {
  // Show results area, hide empty state
  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("results-content").classList.remove("hidden");
  document.getElementById("loading").classList.add("hidden");

  renderInjection(data.injection_analysis);
  renderPii(data.pii_analysis);
  renderPolicy(data.policy);
  renderLlm(data.llm_response, data.llm_error, data.policy.decision);
  document.getElementById("total-time").textContent =
    data.total_time_ms.toFixed(1) + " ms";
}

// ── Stage 1: Injection ────────────────────────────────────────────────────────

function renderInjection(inj) {
  const score = inj.score;
  const risk = inj.risk_level;  // NONE / LOW / MEDIUM / HIGH

  // Score number + progress bar
  document.getElementById("injection-score-num").textContent = score;
  const bar = document.getElementById("injection-bar");
  bar.style.width = score + "%";
  bar.style.backgroundColor = scoreColor(score);

  // Risk badge
  const badge = document.getElementById("injection-badge");
  badge.textContent = risk;
  badge.className = "badge badge-" + risk.toLowerCase();

  // Matched pattern tags
  const tagList = document.getElementById("matched-patterns");
  tagList.innerHTML = "";
  if (inj.matched_patterns.length === 0) {
    tagList.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted)">No patterns matched</span>';
  } else {
    inj.matched_patterns.forEach(p => {
      const tag = document.createElement("span");
      tag.className = "tag tag-pattern";
      tag.textContent = p.replace(/_/g, " ");
      tagList.appendChild(tag);
    });
  }

  document.getElementById("injection-time").textContent =
    `Detection time: ${inj.detection_time_ms} ms`;
}

// ── Stage 2: PII ──────────────────────────────────────────────────────────────

function renderPii(pii) {
  const entities = pii.entities_found || [];
  const realEntities = entities.filter(e => e.type !== "COMPOSITE_RISK");

  // PII badge
  const badge = document.getElementById("pii-badge");
  if (realEntities.length === 0) {
    badge.textContent = "CLEAN";
    badge.className = "badge badge-none";
  } else {
    badge.textContent = realEntities.length + " FOUND";
    badge.className = "badge badge-high";
  }

  // Entity tags
  const tagList = document.getElementById("pii-entities");
  tagList.innerHTML = "";
  if (realEntities.length === 0) {
    tagList.innerHTML = '<span style="font-size:0.8rem;color:var(--text-muted)">No PII detected</span>';
  } else {
    realEntities.forEach(e => {
      const tag = document.createElement("span");
      tag.className = "tag " + entityTagClass(e.type);
      tag.textContent = e.type + " (" + Math.round(e.score * 100) + "%)";
      tag.title = `"${e.text}" — confidence: ${e.score}`;
      tagList.appendChild(tag);
    });
  }

  // Masked text block
  const maskedBlock = document.getElementById("masked-text-block");
  if (pii.masked_text && realEntities.length > 0) {
    maskedBlock.classList.remove("hidden");
    document.getElementById("masked-text-value").textContent = pii.masked_text;
  } else {
    maskedBlock.classList.add("hidden");
  }

  // Composite warning
  const compositeWarn = document.getElementById("composite-warning");
  if (pii.has_composite_risk) {
    compositeWarn.classList.remove("hidden");
  } else {
    compositeWarn.classList.add("hidden");
  }

  document.getElementById("pii-time").textContent =
    `Detection time: ${pii.detection_time_ms} ms`;
}

// ── Stage 3: Policy ───────────────────────────────────────────────────────────

function renderPolicy(policy) {
  const badge = document.getElementById("policy-badge");
  badge.textContent = policy.decision;
  badge.className = "policy-badge policy-" + policy.decision.toLowerCase();

  document.getElementById("policy-reason").textContent = policy.reason;
}

// ── Stage 4: LLM Response ─────────────────────────────────────────────────────

function renderLlm(responseText, error, decision) {
  const responseEl = document.getElementById("llm-response-text");
  const errorEl = document.getElementById("llm-error");

  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  if (decision === "BLOCK") {
    responseEl.innerHTML =
      '<span class="llm-blocked">&#128683; Request was blocked by the security gateway. No LLM call was made.</span>';
    return;
  }

  if (error) {
    responseEl.innerHTML =
      '<span class="llm-blocked">LLM call failed. See error below.</span>';
    errorEl.textContent = "Error: " + error;
    errorEl.classList.remove("hidden");
    return;
  }

  if (responseText) {
    // Escape HTML to prevent XSS from LLM output
    responseEl.textContent = responseText;
  } else {
    responseEl.innerHTML =
      '<span class="llm-blocked">No response received.</span>';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 60) return "var(--block)";
  if (score >= 30) return "var(--flag)";
  if (score > 0) return "var(--mask)";
  return "var(--allow)";
}

function entityTagClass(entityType) {
  const map = {
    "EMAIL_ADDRESS": "tag-email",
    "PHONE_NUMBER": "tag-phone",
    "PK_PHONE_NUMBER": "tag-pk_phone",
    "API_KEY": "tag-apikey",
    "PERSON": "tag-person",
    "COMPOSITE_RISK": "tag-composite",
  };
  return map[entityType] || "tag-default";
}

function setLoading(active) {
  sendBtn.disabled = active;
  const loading = document.getElementById("loading");
  const content = document.getElementById("results-content");

  if (active) {
    document.getElementById("empty-state").classList.add("hidden");
    content.classList.remove("hidden");
    loading.classList.remove("hidden");
  } else {
    loading.classList.add("hidden");
  }
}

function showError(msg) {
  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("results-content").classList.remove("hidden");
  document.getElementById("loading").classList.add("hidden");

  // Show error in policy reason area
  document.getElementById("policy-badge").textContent = "ERROR";
  document.getElementById("policy-badge").className = "policy-badge policy-block";
  document.getElementById("policy-reason").textContent = msg;

  // Clear all other areas (prevent stale data from previous request)
  document.getElementById("injection-score-num").textContent = "--";
  document.getElementById("injection-bar").style.width = "0%";
  document.getElementById("injection-badge").textContent = "";
  document.getElementById("injection-badge").className = "badge";
  document.getElementById("matched-patterns").innerHTML = "";
  document.getElementById("injection-time").textContent = "";
  document.getElementById("pii-badge").textContent = "";
  document.getElementById("pii-badge").className = "badge";
  document.getElementById("pii-entities").innerHTML = "";
  document.getElementById("masked-text-block").classList.add("hidden");
  document.getElementById("composite-warning").classList.add("hidden");
  document.getElementById("pii-time").textContent = "";
  document.getElementById("llm-response-text").textContent = "";
  document.getElementById("llm-error").classList.add("hidden");
  document.getElementById("llm-error").textContent = "";
  document.getElementById("total-time").textContent = "---";
}
