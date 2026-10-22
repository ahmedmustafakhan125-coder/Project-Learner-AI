"""
Policy engine.

Risk formula (configurable in config/gateway_config.yaml):

    final_risk = max(rule_score, semantic_score)
               + pii_weight    * (1 if any PII else 0)
               + secret_weight * (1 if has_secret else 0)
    final_risk = min(final_risk, 1.0)

Decision logic:
    BLOCK if final_risk >= block_min OR any "hard" reason code is present
           (secret extraction, system prompt extraction, jailbreak).
    MASK  if PII present (and not BLOCK).
    ALLOW otherwise.
"""

# Reason codes that always force BLOCK regardless of numeric score.
HARD_BLOCK_REASONS = {
    "RULE_SECRET_EXFIL",
    "RULE_SECRET_EXFIL_UR",
    "RULE_SECRET_EXFIL_KO",
    "RULE_SYSTEM_PROMPT_EXTRACTION",
    "RULE_SYSTEM_PROMPT_EXTRACTION_UR",
    "RULE_SYSTEM_PROMPT_EXTRACTION_KO",
    "RULE_JAILBREAK",
    "RULE_BYPASS_SAFETY",
    "RULE_RAG_MANIPULATION",
    "SEMANTIC_INJECTION",       # set by main.py when semantic_score is high
}


def compute_final_risk(rule_score: float,
                       semantic_score: float,
                       has_pii: bool,
                       has_secret: bool,
                       weights: dict) -> float:
    """Apply the documented risk formula."""
    base = max(rule_score, semantic_score)
    pii_bump = weights.get("pii", 0.20) if has_pii else 0.0
    secret_bump = weights.get("secret", 0.30) if has_secret else 0.0
    total = base + pii_bump + secret_bump
    if total > 1.0:
        total = 1.0
    return round(total, 3)


def decide(rule_score: float,
           semantic_score: float,
           pii_entities: list,
           reason_codes: list,
           has_secret: bool,
           masked_text: str,
           original_text: str,
           config: dict) -> dict:
    """
    Make the final ALLOW / MASK / BLOCK decision.

    Returns a dict with: decision, final_risk, safe_text, reason_codes.
    """
    thresholds = config.get("thresholds", {})
    weights = config.get("weights", {})
    block_min = thresholds.get("block_min", 0.70)

    has_pii = len(pii_entities) > 0
    final_risk = compute_final_risk(rule_score, semantic_score,
                                    has_pii, has_secret, weights)

    # ---- BLOCK conditions ----
    hard_hit = any(code in HARD_BLOCK_REASONS for code in reason_codes)
    if hard_hit or final_risk >= block_min:
        return {
            "decision": "BLOCK",
            "final_risk": final_risk,
            "safe_text": None,
            "reason_codes": reason_codes,
        }

    # ---- MASK condition ----
    if has_pii:
        # Add a reason code for transparency
        if "PII_DETECTED" not in reason_codes:
            reason_codes = reason_codes + ["PII_DETECTED"]
        return {
            "decision": "MASK",
            "final_risk": final_risk,
            "safe_text": masked_text,
            "reason_codes": reason_codes,
        }

    # ---- ALLOW ----
    return {
        "decision": "ALLOW",
        "final_risk": final_risk,
        "safe_text": original_text,
        "reason_codes": reason_codes,
    }
