"""
Presidio Engine Module
======================
Detects and anonymizes PII (Personally Identifiable Information) using
Microsoft Presidio with 5 customizations:

  1. ApiKeyRecognizer         - Detects API keys (OpenAI sk-, Google AIza, Bearer tokens)
  2. PakistaniPhoneRecognizer - Detects Pakistani phone numbers (+92, 03XX formats)
  3. Context-Aware Scoring    - Presidio boosts confidence when context words appear near PII
  4. Composite Entity Detection - Flags when PERSON + EMAIL appear together
  5. Confidence Calibration   - Adjusts scores to reduce false positives

IMPORTANT: The engine is a SINGLETON - initialized once at app startup.
           Never create a new engine inside a route handler.
"""

import time
from typing import List

from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig


# ─── Custom Recognizer 1: API Key Detector ────────────────────────────────────

class ApiKeyRecognizer(PatternRecognizer):
    """
    Detects common API key formats that should never be sent to an LLM.
    Patterns cover OpenAI, Google, and generic bearer tokens.
    """
    PATTERNS = [
        Pattern("OpenAI API Key (hyphen)",  r"sk-[a-zA-Z0-9]{20,}",        0.9),
        Pattern("OpenAI API Key (no hyphen)", r"\bsk[a-zA-Z0-9]{18,}\b",   0.8),
        Pattern("Google API Key",           r"AIza[0-9A-Za-z\-_]{35}",     0.9),
        Pattern("Bearer Token",             r"Bearer\s+[a-zA-Z0-9\-_\.]{20,}", 0.85),
        Pattern("Generic Long Secret",      r"\b[a-zA-Z0-9_\-]{32,}\b",    0.55),
    ]
    # Context words: if these appear near the match, Presidio boosts confidence (+0.35)
    CONTEXT = ["api", "key", "token", "secret", "credential", "auth", "authorization"]

    def __init__(self):
        super().__init__(
            supported_entity="API_KEY",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
        )


# ─── Custom Recognizer 2: Pakistani Phone Number Detector ─────────────────────

class PakistaniPhoneRecognizer(PatternRecognizer):
    """
    Detects Pakistani mobile/phone numbers in common local formats.
    Standard Presidio PHONE_NUMBER misses these Pakistan-specific patterns.
    """
    PATTERNS = [
        Pattern("PK Phone +92",    r"\+92[-\s]?[0-9]{3}[-\s]?[0-9]{7}", 0.85),
        Pattern("PK Phone 03XX",   r"03[0-9]{2}[-\s]?[0-9]{7}",          0.85),
        Pattern("PK Phone 92 raw", r"(?<!\d)92[0-9]{10}(?!\d)",           0.75),
    ]
    # Context words boost confidence when nearby
    CONTEXT = ["phone", "call", "contact", "mobile", "whatsapp", "number", "reach", "dial"]

    def __init__(self):
        super().__init__(
            supported_entity="PK_PHONE_NUMBER",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
        )


# ─── Confidence Calibration Map (Customization 5) ─────────────────────────────
# Presidio sometimes over-detects PERSON (common words tagged as names).
# We adjust scores post-analysis and filter out low-confidence results.

CONFIDENCE_ADJUSTMENTS = {
    "PERSON":         -0.10,  # Presidio over-fires on common English words
    "EMAIL_ADDRESS":   0.00,  # Already very reliable
    "PHONE_NUMBER":   +0.05,  # Slightly boost standard phone detection
    "PK_PHONE_NUMBER": 0.00,  # Our custom recognizer is already calibrated
    "API_KEY":         0.00,  # Our custom recognizer is already calibrated
    "CREDIT_CARD":    +0.05,
    "US_SSN":         +0.05,
    "IBAN_CODE":      +0.05,
    "NRP":            -0.05,  # NRP (Nationality/Religion/Political) can over-fire
}

# Minimum confidence after calibration - results below this are discarded
MIN_CONFIDENCE = 0.4

# All entity types Presidio will scan for
SUPPORTED_ENTITIES = [
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD",
    "US_SSN", "IBAN_CODE", "API_KEY", "PK_PHONE_NUMBER",
    "LOCATION", "NRP",
]


# ─── Singleton Engine ──────────────────────────────────────────────────────────

_engine_instance = None


def get_engine() -> "PresidioEngine":
    """
    Returns the singleton PresidioEngine instance.
    Creates it on first call (takes 2-5 seconds to load spaCy model).
    Call this in FastAPI startup event, not per-request.
    """
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = PresidioEngine()
    return _engine_instance


# ─── Main Engine Class ─────────────────────────────────────────────────────────

class PresidioEngine:
    """
    Wraps Microsoft Presidio for PII detection and anonymization.
    Initialized once; reused for all requests.
    """

    def __init__(self):
        # Build NLP engine using en_core_web_sm (lightweight spaCy model)
        nlp_config = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        }
        provider = NlpEngineProvider(nlp_configuration=nlp_config)
        nlp_engine = provider.create_engine()

        # Create AnalyzerEngine and register our custom recognizers
        self.analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
        self.analyzer.registry.add_recognizer(ApiKeyRecognizer())
        self.analyzer.registry.add_recognizer(PakistaniPhoneRecognizer())

        # AnonymizerEngine replaces PII with readable tokens like <EMAIL_ADDRESS>
        self.anonymizer = AnonymizerEngine()

    def analyze(self, text: str) -> dict:
        """
        Detect PII in text and return anonymized version.

        Returns:
            {
                "entities_found": list of {type, text, score, start, end},
                "masked_text": str,          # text with PII replaced by <TYPE> tokens
                "has_composite_risk": bool,  # True if PERSON + EMAIL both found
                "detection_time_ms": float
            }
        """
        start = time.perf_counter()

        # Step 1: Run Presidio analysis (context-aware scoring is automatic via context= in recognizers)
        raw_results = self.analyzer.analyze(
            text=text,
            language="en",
            entities=SUPPORTED_ENTITIES,
        )

        # Step 2: Confidence calibration - adjust scores and filter low-confidence results
        calibrated_results = []
        for result in raw_results:
            adjustment = CONFIDENCE_ADJUSTMENTS.get(result.entity_type, 0.0)
            calibrated_score = result.score + adjustment

            if calibrated_score >= MIN_CONFIDENCE:
                # Presidio RecognizerResult is immutable-ish; rebuild with new score
                result.score = round(calibrated_score, 3)
                calibrated_results.append(result)

        # Step 3: Composite entity detection - flag when PERSON + EMAIL appear together
        found_types = {r.entity_type for r in calibrated_results}
        has_composite_risk = "PERSON" in found_types and "EMAIL_ADDRESS" in found_types

        # Step 4: Anonymize - replace PII with <TYPE> tokens
        if calibrated_results:
            # Build operator config: replace each entity type with <ENTITY_TYPE>
            operators = {
                entity: OperatorConfig("replace", {"new_value": f"<{entity}>"})
                for entity in SUPPORTED_ENTITIES
            }
            anonymized = self.anonymizer.anonymize(
                text=text,
                analyzer_results=calibrated_results,
                operators=operators,
            )
            masked_text = anonymized.text
        else:
            masked_text = text  # No PII found, text unchanged

        # Step 5: Build entity list for the API response
        entities_found = []
        for r in calibrated_results:
            entities_found.append({
                "type": r.entity_type,
                "text": text[r.start:r.end],
                "score": r.score,
                "start": r.start,
                "end": r.end,
            })

        # If composite risk, add a synthetic entry to make it visible in the UI
        if has_composite_risk:
            entities_found.append({
                "type": "COMPOSITE_RISK",
                "text": "PERSON + EMAIL combination detected",
                "score": 1.0,
                "start": 0,
                "end": 0,
            })

        elapsed_ms = (time.perf_counter() - start) * 1000

        return {
            "entities_found": entities_found,
            "masked_text": masked_text,
            "has_composite_risk": has_composite_risk,
            "detection_time_ms": round(elapsed_ms, 2),
        }
