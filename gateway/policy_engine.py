"""
Policy Engine Module
====================
Makes the final Allow / Mask / Flag / Block decision based on
injection analysis and PII analysis results.

Decision order (most severe checked first):
  1. BLOCK  - injection score is HIGH risk
  2. BLOCK  - PII found AND injection score is MEDIUM or higher (suspicious intent + data)
  3. MASK   - PII found (clean injection, but data must be anonymized before sending to LLM)
  4. FLAG   - injection score is MEDIUM (borderline - warn user but allow through)
  5. ALLOW  - clean input, no issues

No I/O or external calls in this module - pure decision logic only.
"""

from enum import Enum


class PolicyDecision(str, Enum):
    ALLOW = "ALLOW"  # Clean input - send as-is to Gemini
    MASK  = "MASK"   # PII found - send anonymized version to Gemini
    FLAG  = "FLAG"   # Borderline injection - warn user but allow
    BLOCK = "BLOCK"  # High-risk injection - do NOT call Gemini


def evaluate(
    injection_result: dict,
    pii_result: dict,
    high_threshold: int,
    medium_threshold: int,
) -> dict:
    """
    Evaluate the combined risk of a request and return a policy decision.

    Args:
        injection_result: Output from injection_detector.analyze()
        pii_result:       Output from presidio_engine.analyze()
        high_threshold:   Score at/above which injection is HIGH risk
        medium_threshold: Score at/above which injection is MEDIUM risk

    Returns:
        {
            "decision": PolicyDecision,
            "reason": str,
            "text_to_send": str | None  # The text to forward to Gemini (None if BLOCK)
        }
    """
    score = injection_result["score"]
    risk_level = injection_result["risk_level"]
    has_pii = len(pii_result["entities_found"]) > 0
    masked_text = pii_result["masked_text"]
    original_text = injection_result.get("original_text", "")  # passed through from main.py

    # ── Rule 1: BLOCK on HIGH injection score ──────────────────────────────────
    if score >= high_threshold:
        return {
            "decision": PolicyDecision.BLOCK,
            "reason": (
                f"Injection score {score} exceeds HIGH threshold ({high_threshold}). "
                f"Matched patterns: {', '.join(injection_result['matched_patterns'])}."
            ),
            "text_to_send": None,
        }

    # ── Rule 2: BLOCK when PII + medium injection (suspicious intent + data) ───
    if has_pii and score >= medium_threshold:
        pii_types = [e["type"] for e in pii_result["entities_found"]]
        return {
            "decision": PolicyDecision.BLOCK,
            "reason": (
                f"PII detected ({', '.join(pii_types)}) combined with suspicious "
                f"injection score ({score}). Blocked to prevent data exfiltration."
            ),
            "text_to_send": None,
        }

    # ── Rule 3: MASK when PII is present (but injection is low/none) ──────────
    if has_pii:
        pii_types = [e["type"] for e in pii_result["entities_found"]]
        reason = f"PII detected: {', '.join(pii_types)}."
        if pii_result.get("has_composite_risk"):
            reason += " Composite risk: PERSON + EMAIL combination found."
        return {
            "decision": PolicyDecision.MASK,
            "reason": reason,
            "text_to_send": masked_text,
        }

    # ── Rule 4: FLAG when injection score is MEDIUM (borderline) ──────────────
    if score >= medium_threshold:
        return {
            "decision": PolicyDecision.FLAG,
            "reason": (
                f"Injection score {score} is in MEDIUM risk range ({medium_threshold}-{high_threshold-1}). "
                f"Flagged patterns: {', '.join(injection_result['matched_patterns'])}. "
                "Proceeding with caution."
            ),
            "text_to_send": None,  # main.py will pass original text for FLAG
        }

    # ── Rule 5: ALLOW - clean input ────────────────────────────────────────────
    return {
        "decision": PolicyDecision.ALLOW,
        "reason": "No injection patterns detected and no PII found.",
        "text_to_send": None,  # main.py will pass original text for ALLOW
    }
