"""
Multilingual rule-based injection detector.

We keep this simple: a list of patterns per language plus an obfuscation
pass that converts leet-speak and removes punctuation before re-matching
the English patterns.

Output: (rule_score in [0, 1], list of reason_codes)
"""

import re

# ----------------------------------------------------------------------
# English patterns (extended from the midterm). Each entry is a tuple:
#   (compiled_regex, reason_code, weight_in_0_to_1)
# We score by taking the MAX weight that matched and then bumping it a
# little when multiple patterns hit (so combining "ignore instructions"
# AND "reveal system prompt" is scored higher than either alone).
# ----------------------------------------------------------------------
EN_PATTERNS = [
    (re.compile(r"ignore\s+(previous|all|prior|earlier)\s+(instructions?|prompts?|rules?)", re.I),
     "RULE_IGNORE_INSTRUCTIONS", 0.80),
    (re.compile(r"(disregard|forget)\s+(your|the|all|any)\s+(instructions?|rules?|guidelines?)", re.I),
     "RULE_DISREGARD_RULES", 0.80),
    (re.compile(r"pretend\s+(you\s+are|to\s+be)", re.I),
     "RULE_PRETEND_ROLEPLAY", 0.70),
    (re.compile(r"\bDAN\b", re.I),
     "RULE_DAN", 0.75),
    (re.compile(r"\bjailbreak\b", re.I),
     "RULE_JAILBREAK", 0.85),
    (re.compile(r"\bact\s+as\b.*(unrestricted|no\s+rules|anything)", re.I),
     "RULE_JAILBREAK_ROLEPLAY", 0.75),
    (re.compile(r"bypass\s+(safety|filter|restriction|policy|guideline)", re.I),
     "RULE_BYPASS_SAFETY", 0.85),
    (re.compile(r"override\s+system", re.I),
     "RULE_OVERRIDE_SYSTEM", 0.80),
    (re.compile(r"(reveal|show|print|leak|expose)\s+(the\s+)?(system\s+prompt|hidden\s+(prompt|config|configuration|instruction)|your\s+prompt)", re.I),
     "RULE_SYSTEM_PROMPT_EXTRACTION", 0.90),
    (re.compile(r"developer\s+mode", re.I),
     "RULE_DEVELOPER_MODE", 0.70),
    (re.compile(r"(no\s+restrictions?|unrestricted\s+(assistant|mode))", re.I),
     "RULE_NO_RESTRICTIONS", 0.65),
    (re.compile(r"print\s+(any\s+)?(api\s+keys?|passwords?|tokens?|secrets?)", re.I),
     "RULE_SECRET_EXFIL", 0.90),
    (re.compile(r"(email|send|leak)\s+.{0,40}\b(prompt|password|api\s+key|token|secret)", re.I),
     "RULE_SECRET_EXFIL", 0.85),
    (re.compile(r"use\s+the\s+retrieved\s+document\s+as\s+(a\s+)?system\s+instruction", re.I),
     "RULE_RAG_MANIPULATION", 0.85),
    (re.compile(r"override\s+(your|the)\s+policy", re.I),
     "RULE_RAG_MANIPULATION", 0.80),
    (re.compile(r"you\s+are\s+now\s+(a|an)\s+\w+", re.I),
     "RULE_PERSONA_HIJACK", 0.55),
]

# ----------------------------------------------------------------------
# Urdu patterns. Keywords were chosen to match the kind of attack prompts
# the lab final asks us to handle (ignore previous instructions, show
# system prompt, leak password / API key, etc.).
# ----------------------------------------------------------------------
UR_PATTERNS = [
    (re.compile(r"نظر\s*انداز"),
     "RULE_INJECTION_UR_IGNORE", 0.80),
    (re.compile(r"(پچھلی|پہلے\s*والی|سابقہ)\s*(ہدایات|احکامات)"),
     "RULE_INJECTION_UR_PREVIOUS_RULES", 0.80),
    (re.compile(r"سسٹم\s*پرامپٹ"),
     "RULE_SYSTEM_PROMPT_EXTRACTION_UR", 0.85),
    (re.compile(r"(دکھائیں|دکھاؤ|ظاہر\s*کریں)"),
     "RULE_INJECTION_UR_SHOW", 0.55),
    (re.compile(r"(پاس\s*ورڈ|API\s*کلید|خفیہ\s*کلید|ٹوکن)"),
     "RULE_SECRET_EXFIL_UR", 0.85),
    (re.compile(r"بھول\s*جاؤ"),
     "RULE_INJECTION_UR_FORGET", 0.75),
]

# ----------------------------------------------------------------------
# Korean patterns
# ----------------------------------------------------------------------
KO_PATTERNS = [
    (re.compile(r"이전\s*지침"),
     "RULE_INJECTION_KO_PREVIOUS_RULES", 0.80),
    (re.compile(r"무시(하고|해|하라|하세요)"),
     "RULE_INJECTION_KO_IGNORE", 0.80),
    (re.compile(r"시스템\s*프롬프트"),
     "RULE_SYSTEM_PROMPT_EXTRACTION_KO", 0.85),
    (re.compile(r"(보여|보여주|보여주세요|공개)"),
     "RULE_INJECTION_KO_SHOW", 0.55),
    (re.compile(r"(비밀번호|API\s*키|토큰|비밀)"),
     "RULE_SECRET_EXFIL_KO", 0.85),
    (re.compile(r"잊어"),
     "RULE_INJECTION_KO_FORGET", 0.70),
]

# Leet-speak map for the obfuscation pass.
LEET_MAP = str.maketrans({
    "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "5": "s",
    "7": "t", "@": "a", "$": "s",
})


def _deobfuscate(text: str) -> str:
    """Remove punctuation and apply leet-speak mapping for English re-match."""
    cleaned = text.translate(LEET_MAP)
    # Replace any character that is not a letter, digit or space with a space
    cleaned = re.sub(r"[^A-Za-z0-9\s]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def score_rules(text: str) -> tuple[float, list[str]]:
    """
    Run rule detection on `text`. Returns (rule_score, reason_codes).

    The score is the maximum weight of any matched pattern, plus a small
    bonus (+0.05 each) for additional unique matches, clamped to 1.0.
    """
    reasons: list[str] = []
    weights: list[float] = []

    # Run English, Urdu, Korean patterns on the raw text
    for pattern_list in (EN_PATTERNS, UR_PATTERNS, KO_PATTERNS):
        for regex, code, weight in pattern_list:
            if regex.search(text):
                weights.append(weight)
                if code not in reasons:
                    reasons.append(code)

    # Obfuscation pass: clean the text and re-run English patterns
    cleaned = _deobfuscate(text)
    if cleaned and cleaned.lower() != text.lower():
        for regex, code, weight in EN_PATTERNS:
            if regex.search(cleaned):
                weights.append(weight)
                if "RULE_OBFUSCATED" not in reasons:
                    reasons.append("RULE_OBFUSCATED")
                if code not in reasons:
                    reasons.append(code)

    if not weights:
        return 0.0, []

    score = max(weights) + 0.05 * (len(weights) - 1)
    if score > 1.0:
        score = 1.0

    return round(score, 3), reasons
