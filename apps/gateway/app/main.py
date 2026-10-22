"""
FastAPI app - the security gateway entry point.

Pipeline for every /analyze request:
  1. Language detection
  2. Rule-based injection detection
  3. Semantic (TF-IDF + LogReg) injection detection
  4. Presidio PII analysis + anonymization
  5. Policy engine: ALLOW / MASK / BLOCK
  6. Audit log writes a JSON line
  7. Mocked LLM response (only on ALLOW or MASK)
"""

import asyncio
import os
import time
import uuid

import yaml
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.detectors import rule_detector, semantic_detector
from app.pii.presidio_custom import get_engine
from app.policy import policy_engine
from app.utils import language as language_util
from app.utils.logging import log_decision, read_recent


# ─── Load config once at import time ──────────────────────────────────────────
CONFIG_PATH = os.environ.get("GATEWAY_CONFIG", "config/gateway_config.yaml")
with open(CONFIG_PATH, "r", encoding="utf-8") as _f:
    CONFIG = yaml.safe_load(_f)

MAX_INPUT_LENGTH = CONFIG.get("limits", {}).get("max_input_length", 2000)
AUDIT_LOG_PATH = CONFIG.get("paths", {}).get("audit_log", "results/audit_log.jsonl")
SEMANTIC_MODEL_PATH = CONFIG.get("paths", {}).get("semantic_model", "results/semantic_model.pkl")
MOCK_LLM_RESPONSE = CONFIG.get("mock_llm_response", "[MOCKED LLM RESPONSE]")
BLOCK_MIN = CONFIG.get("thresholds", {}).get("block_min", 0.70)
SEMANTIC_BLOCK_THRESHOLD = 0.70  # semantic prob above this contributes SEMANTIC_INJECTION reason


# ─── FastAPI app + middleware ─────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="Robust Multilingual LLM Security Gateway",
    description="Hybrid (rule + semantic) gateway with Presidio PII and auditable policy decisions.",
    version="2.0.0",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Mount the static UI from the midterm (same folder)
if os.path.isdir("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")


# ─── Startup: load Presidio and the semantic model once ───────────────────────
@app.on_event("startup")
async def _startup():
    loop = asyncio.get_event_loop()
    # Presidio + spaCy is slow (2-5s) so we load it in a thread.
    await loop.run_in_executor(None, get_engine)
    # Load the semantic model (or None if it wasn't trained yet)
    app.state.semantic_model = semantic_detector.load_model(SEMANTIC_MODEL_PATH)
    print(f"[startup] semantic_model loaded: {app.state.semantic_model is not None}")
    print(f"[startup] config: {CONFIG_PATH}")


# ─── Request model ────────────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    prompt: str
    input_id: str | None = None

    @field_validator("prompt")
    @classmethod
    def _check_prompt(cls, v: str) -> str:
        # Strip control characters but keep newlines/tabs
        v = "".join(c for c in v if ord(c) >= 32 or c in ("\n", "\t"))
        v = v.strip()
        if not v:
            raise ValueError("Prompt cannot be empty.")
        if len(v) > MAX_INPUT_LENGTH:
            raise ValueError(f"Prompt exceeds {MAX_INPUT_LENGTH} characters.")
        return v


# ─── Helper that does the whole pipeline (used by /analyze AND by run_evaluation.py) ────
def run_pipeline(prompt: str,
                 input_id: str | None,
                 semantic_model,
                 use_semantic: bool = True) -> dict:
    """
    The full gateway pipeline as a plain function. Returns the JSON dict
    that /analyze sends back to the user.

    `use_semantic=False` skips the semantic detector. The evaluation script
    uses this to compare rule-only vs hybrid.
    """
    started_at = time.perf_counter()

    if input_id is None:
        input_id = "case_" + uuid.uuid4().hex[:8]

    # 1. Language
    lang = language_util.detect_language(prompt)
    mixed = language_util.is_mixed_language(prompt)

    # 2. Rule detector
    rule_score, rule_reasons = rule_detector.score_rules(prompt)

    # 3. Semantic detector (skipped when use_semantic=False)
    if use_semantic and semantic_model is not None:
        semantic_score = semantic_detector.score_semantic(semantic_model, prompt)
    else:
        semantic_score = 0.0

    # 4. Presidio PII
    presidio = get_engine().analyze(prompt)
    pii_entities = presidio["entities"]
    masked_text = presidio["masked_text"]
    composite_pii = presidio["composite_pii"]
    has_secret = presidio["has_secret"]

    # Collect reason codes from all sources
    reasons = list(rule_reasons)
    if semantic_score >= SEMANTIC_BLOCK_THRESHOLD:
        reasons.append("SEMANTIC_INJECTION")
    if composite_pii:
        reasons.append("COMPOSITE_PII")
    if mixed:
        reasons.append("MIXED_LANGUAGE")
    if has_secret:
        reasons.append("SECRET_REFERENCE")

    # 5. Policy
    policy_result = policy_engine.decide(
        rule_score=rule_score,
        semantic_score=semantic_score,
        pii_entities=pii_entities,
        reason_codes=reasons,
        has_secret=has_secret,
        masked_text=masked_text,
        original_text=prompt,
        config=CONFIG,
    )

    # 6. Mock LLM (only if not blocked)
    if policy_result["decision"] == "BLOCK":
        llm_response = None
    else:
        llm_response = MOCK_LLM_RESPONSE

    latency_ms = round((time.perf_counter() - started_at) * 1000, 2)

    # Build response (matches the JSON shape in the lab final PDF)
    response = {
        "input_id": input_id,
        "language": lang,
        "rule_score": rule_score,
        "semantic_score": semantic_score,
        "pii_entities": pii_entities,
        "final_risk": policy_result["final_risk"],
        "decision": policy_result["decision"],
        "safe_text": policy_result["safe_text"],
        "reason_codes": policy_result["reason_codes"],
        "llm_response": llm_response,
        "latency_ms": latency_ms,
    }

    # 7. Audit log (entity TEXT is intentionally stripped for secrets)
    safe_entities_for_log = []
    for e in pii_entities:
        safe_entities_for_log.append({
            "type": e["type"],
            "score": e["score"],
            # Do NOT log the raw secret value; just keep type + score.
        })
    log_record = {
        "input_id": input_id,
        "language": lang,
        "rule_score": rule_score,
        "semantic_score": semantic_score,
        "pii_entities": safe_entities_for_log,
        "final_risk": policy_result["final_risk"],
        "decision": policy_result["decision"],
        "reason_codes": policy_result["reason_codes"],
        "latency_ms": latency_ms,
    }
    log_decision(log_record, AUDIT_LOG_PATH)

    return response


# ─── Endpoints ────────────────────────────────────────────────────────────────
@app.post("/analyze")
@limiter.limit("60/minute")
async def analyze(request: Request, body: AnalyzeRequest):
    """Main gateway endpoint."""
    loop = asyncio.get_event_loop()
    # Presidio is sync and slow-ish - run in thread executor to keep the event loop free.
    result = await loop.run_in_executor(
        None,
        run_pipeline,
        body.prompt,
        body.input_id,
        app.state.semantic_model,
        True,
    )
    return result


@app.get("/health")
async def health():
    return {"status": "ok", "service": "Robust LLM Security Gateway"}


@app.get("/metrics")
async def metrics():
    """Compute latency stats and decision counts from the audit log."""
    recent = read_recent(AUDIT_LOG_PATH, limit=200)
    if not recent:
        return {"total_requests": 0, "message": "No requests yet."}

    latencies = sorted([r["latency_ms"] for r in recent])
    n = len(latencies)
    mean_ms = sum(latencies) / n
    median_ms = latencies[n // 2]
    p95_idx = max(0, int(0.95 * n) - 1)
    p95_ms = latencies[p95_idx]

    decisions = {"ALLOW": 0, "MASK": 0, "BLOCK": 0}
    for r in recent:
        decisions[r["decision"]] = decisions.get(r["decision"], 0) + 1

    return {
        "total_requests": n,
        "latency": {
            "mean_ms": round(mean_ms, 2),
            "median_ms": round(median_ms, 2),
            "p95_ms": round(p95_ms, 2),
        },
        "decisions": decisions,
    }


# Keep the midterm /api/* endpoints working too (the UI calls them)
@app.post("/api/analyze")
@limiter.limit("60/minute")
async def analyze_legacy(request: Request, body: dict):
    """Backwards-compatible endpoint for the existing static UI."""
    prompt = body.get("message") or body.get("prompt") or ""
    if not prompt or not isinstance(prompt, str):
        return {"error": "missing 'message' field"}

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        run_pipeline,
        prompt,
        None,
        app.state.semantic_model,
        True,
    )
    # Reshape into the midterm response so the existing static/script.js works
    return {
        "original_input": prompt,
        "injection_analysis": {
            "score": int(result["rule_score"] * 100),
            "risk_level": _risk_level(result["rule_score"]),
            "matched_patterns": [r for r in result["reason_codes"] if r.startswith("RULE_")],
            "detection_time_ms": 0.0,
        },
        "pii_analysis": {
            "entities_found": result["pii_entities"],
            "masked_text": result["safe_text"] if result["decision"] == "MASK" else None,
            "has_composite_risk": "COMPOSITE_PII" in result["reason_codes"],
            "detection_time_ms": 0.0,
        },
        "policy": {
            "decision": result["decision"],
            "reason": ", ".join(result["reason_codes"]) or "No risk detected.",
        },
        "llm_response": result["llm_response"],
        "llm_error": None,
        "total_time_ms": result["latency_ms"],
        # extra final-lab fields
        "language": result["language"],
        "semantic_score": result["semantic_score"],
        "final_risk": result["final_risk"],
    }


def _risk_level(score: float) -> str:
    if score >= 0.7: return "HIGH"
    if score >= 0.3: return "MEDIUM"
    if score > 0:    return "LOW"
    return "NONE"


@app.get("/api/health")
async def api_health():
    return await health()


@app.get("/api/metrics")
async def api_metrics():
    return await metrics()


@app.get("/")
async def index():
    if os.path.exists("static/index.html"):
        return FileResponse("static/index.html")
    return {"message": "Gateway is running. POST /analyze with {prompt: ...}"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
