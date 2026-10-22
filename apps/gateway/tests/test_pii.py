"""Tests for the customized Presidio engine."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.pii.presidio_custom import get_engine


def _types(entities):
    return {e["type"] for e in entities}


def test_email_is_detected_and_masked():
    res = get_engine().analyze("My email is ali@example.com please reply.")
    assert "EMAIL_ADDRESS" in _types(res["entities"])
    assert "<EMAIL>" in res["masked_text"]


def test_cnic_recognizer_fires():
    res = get_engine().analyze("My CNIC is 35202-1234567-1 please add it.")
    assert "CNIC" in _types(res["entities"])
    assert "<CNIC>" in res["masked_text"]


def test_student_id_recognizer_fires():
    res = get_engine().analyze("Please use student id FA21-BCS-123 in the form.")
    assert "STUDENT_ID" in _types(res["entities"])
    assert "<STUDENT_ID>" in res["masked_text"]


def test_api_key_recognizer_fires():
    res = get_engine().analyze(
        "Use this key sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 for testing."
    )
    assert "API_KEY" in _types(res["entities"])
    assert res["has_secret"] is True


def test_pakistani_phone_recognizer_fires():
    res = get_engine().analyze("Call me on 03001234567 tomorrow morning.")
    assert "PHONE_NUMBER" in _types(res["entities"])


def test_composite_pii_flag():
    res = get_engine().analyze(
        "Student FA21-BCS-123 has email ali@uni.edu.pk for registration."
    )
    assert res["composite_pii"] is True


def test_no_pii_returns_original_text():
    res = get_engine().analyze("Explain TCP and UDP briefly.")
    assert res["entities"] == []
    assert res["masked_text"] == "Explain TCP and UDP briefly."
