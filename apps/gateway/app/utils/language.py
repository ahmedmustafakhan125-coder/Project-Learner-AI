"""
Language detection for the gateway.

We need to know whether the input is English, Urdu, or Korean
because the rule detector picks different keyword lists per language.

Two-step strategy (super simple):
1. If the text contains a Hangul character (Korean script)  -> "ko"
   If the text contains an Arabic-script character (Urdu)   -> "ur"
   This catches the language even when only one word is in that script.
2. Otherwise call the `langdetect` library and map its result
   to "en" / "ur" / "ko" / "other".
"""

import re

from langdetect import detect, DetectorFactory, LangDetectException

# Make langdetect deterministic so the same text always gives the same result.
DetectorFactory.seed = 0

# Pre-compiled script ranges (only used for the fast script check)
HANGUL_RE = re.compile(r"[가-힯ᄀ-ᇿ㄰-㆏]")
ARABIC_RE = re.compile(r"[؀-ۿݐ-ݿ]")


def detect_language(text: str) -> str:
    """
    Return one of: "en", "ur", "ko", "other".

    Mixed-language input (e.g. an English sentence with one Urdu word) is
    classified by the script of the non-English part, which is what we want
    because the attack is usually hidden in the non-English part.
    """
    # 1. Fast script check - catches mixed-language attacks
    if HANGUL_RE.search(text):
        return "ko"
    if ARABIC_RE.search(text):
        return "ur"

    # 2. Fallback to langdetect for everything else
    try:
        code = detect(text)
    except LangDetectException:
        return "other"

    if code == "en":
        return "en"
    if code == "ur":
        return "ur"
    if code == "ko":
        return "ko"
    return "other"


def is_mixed_language(text: str) -> bool:
    """
    True if the text contains BOTH Latin letters and a non-Latin script
    (Hangul or Arabic). Used for the 'mixed' label in the audit log.
    """
    has_latin = bool(re.search(r"[A-Za-z]", text))
    has_other_script = bool(HANGUL_RE.search(text) or ARABIC_RE.search(text))
    return has_latin and has_other_script
