import asyncio
import logging
import os
import time
from collections import deque

from dotenv import load_dotenv

# IMPORTANT: load_dotenv() MUST be called before any os.getenv() calls
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from gateway import injection_detector, policy_engine
from gateway.presidio_engine import get_engine
from gateway.llm_client import GeminiClient

# ─── Logging setup (metadata only, never log user messages) ───────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("gateway")

# ─── Config from environment ───────────────────────────────────────────────────
HIGH_THRESHOLD = int(os.getenv("HIGH_RISK_THRESHOLD", "60"))
MEDIUM_THRESHOLD = int(os.getenv("MEDIUM_RISK_THRESHOLD", "30"))
MAX_INPUT_LENGTH = int(os.getenv("MAX_INPUT_LENGTH", "2000"))
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000").split(",")

# ─── In-memory metrics store (last 100 requests, no sensitive data) ────────────
metrics_store = deque(maxlen=100)

# ─── Rate limiter (10/min to stay within Gemini free tier of 15/min) ──────────
limiter = Limiter(key_func=get_remote_address)

# ─── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Secure LLM Gateway",
    description="Security gateway protecting Gemini LLM from injection, jailbreak, and PII leakage.",
    version="1.0.0",
    docs_url="/docs",
)

# Attach rate limiter to app state
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS middleware - only allow configured origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Serve static files (frontend)
app.mount("/static", StaticFiles(directory="static"), name="static")


# ─── Startup: initialize heavy components once ────────────────────────────────
@app.on_event("startup")
async def startup_event():
    """
    Initialize Presidio (loads spaCy model - takes 2-5 seconds) and Gemini client.
    Running this at startup means the first user request is not slow.
    """
    logger.info("Gateway starting up...")

    # Initialize Presidio in a thread executor (it's sync and slow)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_engine)
    logger.info("Presidio engine ready.")

    # Initialize Gemini client
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key or api_key == "your_gemini_api_key_here":
        logger.warning("GEMINI_API_KEY not set! LLM calls will fail. Check your .env file.")
    app.state.gemini = GeminiClient(api_key)
    logger.info("Gemini client ready.")

    logger.info("Gateway startup complete. Ready to accept requests.")


# ─── Input validation model ────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    message: str

    @field_validator("message")
    @classmethod
    def validate_message(cls, v: str) -> str:
        # Strip null bytes and control characters (security)
        v = v.replace("\x00", "")
        v = "".join(c for c in v if ord(c) >= 32 or c in ("\n", "\t"))

        v = v.strip()

        if len(v) == 0:
            raise ValueError("Message cannot be empty.")

        if len(v) > MAX_INPUT_LENGTH:
            raise ValueError(
                f"Message exceeds the maximum allowed length of {MAX_INPUT_LENGTH} characters."
            )

        return v


# ─── Main gateway endpoint ─────────────────────────────────────────────────────
@app.post("/api/analyze")
@limiter.limit("10/minute")
async def analyze(request: Request, body: AnalyzeRequest):
    """
    Main security gateway pipeline:
    1. Injection detection (pattern scoring)
    2. Presidio PII detection + anonymization
    3. Policy decision (ALLOW / MASK / FLAG / BLOCK)
    4. Gemini API call (only if policy allows)

    Returns full analysis including scores, entities, decision, and LLM response.
    """
    pipeline_start = time.perf_counter()
    original = body.message

    # ── Stage 1: Injection Detection ──────────────────────────────────────────
    injection_result = injection_detector.analyze(original)
    # Attach original text so policy engine can reference it
    injection_result["original_text"] = original

    # ── Stage 2: Presidio PII Detection ───────────────────────────────────────
    loop = asyncio.get_event_loop()
    engine = get_engine()
    pii_result = await loop.run_in_executor(None, engine.analyze, original)

    # ── Stage 3: Policy Decision ───────────────────────────────────────────────
    policy = policy_engine.evaluate(
        injection_result=injection_result,
        pii_result=pii_result,
        high_threshold=HIGH_THRESHOLD,
        medium_threshold=MEDIUM_THRESHOLD,
    )

    # Determine what text to actually send to the LLM
    if policy["decision"] in ("ALLOW", "FLAG"):
        text_to_llm = original
    elif policy["decision"] == "MASK":
        text_to_llm = pii_result["masked_text"]
    else:
        text_to_llm = None  # BLOCK - nothing goes to LLM

    # ── Stage 4: Gemini API Call (only if not blocked) ─────────────────────────
    llm_result = None
    if text_to_llm is not None:
        llm_result = await app.state.gemini.generate(text_to_llm)

    # ── Metrics (no sensitive data stored) ────────────────────────────────────
    total_ms = round((time.perf_counter() - pipeline_start) * 1000, 2)
    metrics_store.append({
        "total_ms": total_ms,
        "injection_ms": injection_result["detection_time_ms"],
        "presidio_ms": pii_result["detection_time_ms"],
        "llm_ms": llm_result["llm_time_ms"] if llm_result else 0.0,
        "decision": policy["decision"],
    })

    # ── Safe logging (metadata only) ───────────────────────────────────────────
    logger.info(
        "Request | decision=%s | inj_score=%d | pii_count=%d | total_ms=%.1f",
        policy["decision"],
        injection_result["score"],
        len([e for e in pii_result["entities_found"] if e["type"] != "COMPOSITE_RISK"]),
        total_ms,
    )

    # ── Build and return response ──────────────────────────────────────────────
    # Remove internal field before returning
    injection_result.pop("original_text", None)

    return {
        "original_input": original,
        "injection_analysis": {
            "score": injection_result["score"],
            "risk_level": injection_result["risk_level"],
            "matched_patterns": injection_result["matched_patterns"],
            "detection_time_ms": injection_result["detection_time_ms"],
        },
        "pii_analysis": {
            "entities_found": pii_result["entities_found"],
            "masked_text": pii_result["masked_text"] if pii_result["entities_found"] else None,
            "has_composite_risk": pii_result["has_composite_risk"],
            "detection_time_ms": pii_result["detection_time_ms"],
        },
        "policy": {
            "decision": policy["decision"],
            "reason": policy["reason"],
        },
        "llm_response": llm_result["response_text"] if llm_result else None,
        "llm_error": llm_result["error"] if llm_result else None,
        "total_time_ms": total_ms,
    }


# ─── Metrics endpoint ──────────────────────────────────────────────────────────
@app.get("/api/metrics")
async def get_metrics():
    """Returns latency statistics and decision distribution for the last 100 requests."""
    if not metrics_store:
        return {"message": "No requests processed yet.", "total_requests": 0}

    times = [m["total_ms"] for m in metrics_store]
    inj_times = [m["injection_ms"] for m in metrics_store]
    presidio_times = [m["presidio_ms"] for m in metrics_store]
    llm_times = [m["llm_ms"] for m in metrics_store if m["llm_ms"] > 0]
    decisions = [m["decision"] for m in metrics_store]

    return {
        "total_requests": len(metrics_store),
        "latency": {
            "total_avg_ms": round(sum(times) / len(times), 2),
            "total_min_ms": round(min(times), 2),
            "total_max_ms": round(max(times), 2),
            "injection_avg_ms": round(sum(inj_times) / len(inj_times), 3),
            "presidio_avg_ms": round(sum(presidio_times) / len(presidio_times), 2),
            "llm_avg_ms": round(sum(llm_times) / len(llm_times), 2) if llm_times else 0,
        },
        "decisions": {
            "ALLOW": decisions.count("ALLOW"),
            "MASK": decisions.count("MASK"),
            "FLAG": decisions.count("FLAG"),
            "BLOCK": decisions.count("BLOCK"),
        },
    }


# ─── Health check endpoint ─────────────────────────────────────────────────────
@app.get("/api/health")
async def health_check():
    """Simple health check to verify the gateway is running."""
    return {"status": "ok", "service": "Secure LLM Gateway"}


# ─── Serve frontend ────────────────────────────────────────────────────────────
@app.get("/")
async def serve_frontend():
    """Serves the main HTML frontend."""
    return FileResponse("static/index.html")


# ─── Run directly ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    host = os.getenv("APP_HOST", "0.0.0.0")
    port = int(os.getenv("APP_PORT", "8000"))

    logger.info("Starting Secure LLM Gateway on http://%s:%d", host, port)
    uvicorn.run("main:app", host=host, port=port, reload=False)
