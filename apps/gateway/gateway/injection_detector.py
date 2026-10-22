

import re
import time
import os

# --- Threshold config (loaded from .env via main.py, with defaults) ---
HIGH_RISK_THRESHOLD = int(os.getenv("HIGH_RISK_THRESHOLD", "60"))
MEDIUM_RISK_THRESHOLD = int(os.getenv("MEDIUM_RISK_THRESHOLD", "30"))

# Pattern list: (compiled_regex, human_readable_name, score_weight) ---
# Each pattern matches a known injection/jailbreak technique.
# Weights reflect severity: higher = more dangerous.
PATTERNS = [
    (re.compile(r"ignore\s+(previous|all|prior)\s+(instructions?|prompts?|rules?)", re.IGNORECASE),
     "ignore_instructions", 40),

    (re.compile(r"pretend\s+(you\s+are|to\s+be)", re.IGNORECASE),
     "pretend_to_be", 35),

    (re.compile(r"\bDAN\b", re.IGNORECASE),
     "DAN_jailbreak", 35),

    (re.compile(r"\bjailbreak\b", re.IGNORECASE),
     "jailbreak_keyword", 40),

    (re.compile(r"\bact\s+as\b", re.IGNORECASE),
     "act_as", 25),

    (re.compile(r"bypass\s+(safety|filter|restriction|policy|guideline)", re.IGNORECASE),
     "bypass_safety", 40),

    (re.compile(r"override\s+system", re.IGNORECASE),
     "override_system", 40),

    (re.compile(r"reveal\s+(system\s+prompt|instructions|your\s+prompt)", re.IGNORECASE),
     "reveal_system_prompt", 35),

    (re.compile(r"roleplay\s+as", re.IGNORECASE),
     "roleplay_as", 25),

    (re.compile(r"you\s+are\s+now\s+(a|an)\b", re.IGNORECASE),
     "you_are_now", 30),

    (re.compile(r"(disregard|forget|ignore)\s+(your|the)\s+(instructions?|rules?|guidelines?)", re.IGNORECASE),
     "disregard_rules", 40),

    (re.compile(r"developer\s+mode", re.IGNORECASE),
     "developer_mode", 35),

    (re.compile(r"(no\s+restrictions?|unrestricted)", re.IGNORECASE),
     "no_restrictions", 30),

    (re.compile(r"system\s+prompt", re.IGNORECASE),
     "system_prompt_reference", 20),
]


def analyze(text: str) -> dict:
    """
    Scan text for injection/jailbreak patterns and return a risk score.

    Returns:
        {
            "score": int,               # 0-100 (higher = more risky)
            "risk_level": str,          # NONE / LOW / MEDIUM / HIGH
            "matched_patterns": list,   # names of matched patterns
            "detection_time_ms": float  # time taken in milliseconds
        }
    """
    start = time.perf_counter()

    score = 0
    matched = []

    for pattern, name, weight in PATTERNS:
        if pattern.search(text):
            score += weight
            matched.append(name)

    # Clamp score to max 100
    score = min(score, 100)

    # Determine risk level based on thresholds
    if score >= HIGH_RISK_THRESHOLD:
        risk_level = "HIGH"
    elif score >= MEDIUM_RISK_THRESHOLD:
        risk_level = "MEDIUM"
    elif score > 0:
        risk_level = "LOW"
    else:
        risk_level = "NONE"

    elapsed_ms = (time.perf_counter() - start) * 1000

    return {
        "score": score,
        "risk_level": risk_level,
        "matched_patterns": matched,
        "detection_time_ms": round(elapsed_ms, 3),
    }
