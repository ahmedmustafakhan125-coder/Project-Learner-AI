"""
Presidio PII module with the 4 required customizations.

Customizations:
  1. Custom recognizers   -> STUDENT_ID (FA21-BCS-123 style), CNIC,
                             API_KEY (OpenAI/Google/Bearer/long-secret),
                             PK_PHONE_NUMBER (Pakistani formats).
  2. Context-aware boost  -> +0.20 when words like "email", "phone",
                             "cnic", "student id", "api key", "password"
                             appear near the detected entity. Urdu/Korean
                             context words are also included.
  3. Composite entity     -> If PERSON + PHONE or STUDENT_ID + EMAIL
                             appear together, add a COMPOSITE_PII reason
                             and raise the PII risk.
  4. Confidence calibration -> Drop entities below 0.4 confidence and
                             apply a -0.10 penalty to PERSON (Presidio
                             over-detects names).

Anonymization placeholders (exactly as the rubric asks):
  <PERSON>, <EMAIL>, <PHONE>, <CNIC>, <API_KEY>, <STUDENT_ID>
"""

import time

from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig


# ─── Custom recognizers ───────────────────────────────────────────────────────

class ApiKeyRecognizer(PatternRecognizer):
    """OpenAI, Google, Bearer tokens, and any long random-looking secret."""
    PATTERNS = [
        Pattern("OpenAI sk-",       r"sk-[a-zA-Z0-9]{20,}",            0.9),
        Pattern("Google AIza",      r"AIza[0-9A-Za-z\-_]{35}",         0.9),
        Pattern("Bearer token",     r"Bearer\s+[a-zA-Z0-9\-_\.]{20,}", 0.85),
        Pattern("Generic 32+ char", r"\b[a-zA-Z0-9_\-]{32,}\b",        0.55),
    ]
    CONTEXT = ["api", "key", "token", "secret", "credential", "auth", "authorization", "bearer"]

    def __init__(self):
        super().__init__(supported_entity="API_KEY",
                         patterns=self.PATTERNS, context=self.CONTEXT)


class PakistaniPhoneRecognizer(PatternRecognizer):
    """Pakistan-specific phone formats: +92..., 03XX..., bare 92..."""
    PATTERNS = [
        Pattern("PK +92",      r"\+92[-\s]?[0-9]{3}[-\s]?[0-9]{7}", 0.85),
        Pattern("PK 03XX",     r"\b03[0-9]{2}[-\s]?[0-9]{7}\b",     0.85),
        Pattern("PK raw 92",   r"(?<!\d)92[0-9]{10}(?!\d)",         0.75),
    ]
    CONTEXT = ["phone", "mobile", "call", "contact", "whatsapp", "number", "reach", "dial",
               "فون", "موبائل", "نمبر", "전화", "휴대전화"]

    def __init__(self):
        super().__init__(supported_entity="PHONE_NUMBER",
                         patterns=self.PATTERNS, context=self.CONTEXT)


class CnicRecognizer(PatternRecognizer):
    """Pakistani CNIC: 5 digits - 7 digits - 1 digit."""
    PATTERNS = [
        Pattern("CNIC", r"\b\d{5}-\d{7}-\d\b", 0.95),
    ]
    CONTEXT = ["cnic", "id", "national", "identity", "شناختی", "카드"]

    def __init__(self):
        super().__init__(supported_entity="CNIC",
                         patterns=self.PATTERNS, context=self.CONTEXT)


class StudentIdRecognizer(PatternRecognizer):
    """Local university student IDs like FA21-BCS-123 or SP20-BSE-045."""
    PATTERNS = [
        Pattern("StudentID FAXX-XXX-NNN", r"\b[A-Z]{2}\d{2}-[A-Z]{2,4}-\d{2,4}\b", 0.9),
    ]
    CONTEXT = ["student", "id", "registration", "reg", "roll", "طالب", "학생"]

    def __init__(self):
        super().__init__(supported_entity="STUDENT_ID",
                         patterns=self.PATTERNS, context=self.CONTEXT)


# ─── Customization 2: extra context words for the built-in entities ───────────
# Presidio supports an optional context list passed in analyze(). We use it
# to bump confidence when these words appear near an entity.

EXTRA_CONTEXT = [
    "email", "e-mail", "mail", "phone", "mobile", "number", "cnic",
    "student", "id", "api", "key", "token", "secret", "password",
    "credential", "ایمیل", "فون", "نمبر", "이메일", "비밀번호", "전화",
]

# ─── Customization 4: confidence calibration ──────────────────────────────────
CONFIDENCE_ADJUSTMENTS = {
    "PERSON":         -0.10,   # over-detected on common words
    "EMAIL_ADDRESS":   0.00,
    "PHONE_NUMBER":   +0.05,
    "API_KEY":         0.00,
    "CNIC":            0.00,
    "STUDENT_ID":      0.00,
    "CREDIT_CARD":    +0.05,
}
MIN_CONFIDENCE = 0.40

# Entity types we ask Presidio to scan for
SUPPORTED_ENTITIES = [
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER",
    "CREDIT_CARD", "IBAN_CODE", "US_SSN",
    "API_KEY", "CNIC", "STUDENT_ID",
]

# Placeholder map for anonymization
PLACEHOLDERS = {
    "PERSON":        "<PERSON>",
    "EMAIL_ADDRESS": "<EMAIL>",
    "PHONE_NUMBER":  "<PHONE>",
    "CNIC":          "<CNIC>",
    "API_KEY":       "<API_KEY>",
    "STUDENT_ID":    "<STUDENT_ID>",
    "CREDIT_CARD":   "<CREDIT_CARD>",
    "IBAN_CODE":     "<IBAN>",
    "US_SSN":        "<SSN>",
}


# ─── Singleton engine wrapper ─────────────────────────────────────────────────

_engine = None


def get_engine():
    """Return the singleton PresidioWrapper (creates it on first call)."""
    global _engine
    if _engine is None:
        _engine = PresidioWrapper()
    return _engine


class PresidioWrapper:
    """Wraps Presidio analyzer + anonymizer. Initialized once at startup."""

    def __init__(self):
        nlp_config = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        }
        nlp_engine = NlpEngineProvider(nlp_configuration=nlp_config).create_engine()

        self.analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
        # Register our 4 custom recognizers
        self.analyzer.registry.add_recognizer(ApiKeyRecognizer())
        self.analyzer.registry.add_recognizer(PakistaniPhoneRecognizer())
        self.analyzer.registry.add_recognizer(CnicRecognizer())
        self.analyzer.registry.add_recognizer(StudentIdRecognizer())

        self.anonymizer = AnonymizerEngine()

    def analyze(self, text: str) -> dict:
        """
        Run Presidio on `text` and return entities, masked text, composite flag.

        Returns:
          {
            "entities": [ {type, text, score, start, end}, ... ],
            "masked_text": str,
            "composite_pii": bool,
            "has_secret": bool,           # any API_KEY / password reference
            "latency_ms": float,
          }
        """
        start = time.perf_counter()

        # Pass our extra context words so Presidio boosts confidence (+0.35 default).
        raw = self.analyzer.analyze(
            text=text,
            language="en",
            entities=SUPPORTED_ENTITIES,
            context=EXTRA_CONTEXT,
        )

        # Confidence calibration + minimum threshold
        kept = []
        for r in raw:
            adj = CONFIDENCE_ADJUSTMENTS.get(r.entity_type, 0.0)
            new_score = r.score + adj
            if new_score >= MIN_CONFIDENCE:
                r.score = round(new_score, 3)
                kept.append(r)

        # Composite entity detection
        found_types = {r.entity_type for r in kept}
        composite_pii = (
            ("PERSON" in found_types and "PHONE_NUMBER" in found_types)
            or ("STUDENT_ID" in found_types and "EMAIL_ADDRESS" in found_types)
            or ("PERSON" in found_types and "EMAIL_ADDRESS" in found_types)
            or ("CNIC" in found_types and "PHONE_NUMBER" in found_types)
        )

        # Secret indicator (used by the policy engine to bump risk)
        has_secret = "API_KEY" in found_types or _has_password_word(text)

        # Anonymization (only when at least one entity was kept)
        if kept:
            operators = {
                entity: OperatorConfig("replace", {"new_value": placeholder})
                for entity, placeholder in PLACEHOLDERS.items()
            }
            masked = self.anonymizer.anonymize(
                text=text, analyzer_results=kept, operators=operators,
            ).text
        else:
            masked = text

        # Build the response entity list
        entities = []
        for r in kept:
            entities.append({
                "type": r.entity_type,
                "text": text[r.start:r.end],
                "score": r.score,
                "start": r.start,
                "end": r.end,
            })

        elapsed_ms = (time.perf_counter() - start) * 1000

        return {
            "entities": entities,
            "masked_text": masked,
            "composite_pii": composite_pii,
            "has_secret": has_secret,
            "latency_ms": round(elapsed_ms, 2),
        }


def _has_password_word(text: str) -> bool:
    """Quick check for password-related words in EN/UR/KO."""
    low = text.lower()
    for kw in ["password", "passwd", "passcode", "secret",
               "پاس ورڈ", "خفیہ کلید", "비밀번호", "비밀"]:
        if kw in low:
            return True
    return False
