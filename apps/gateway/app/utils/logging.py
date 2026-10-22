"""
Tiny JSONL audit logger.

Every /analyze request appends one JSON line to results/audit_log.jsonl.
We never log the raw text of secrets - only entity types + scores.
"""

import json
import os
from datetime import datetime


def log_decision(record: dict, log_path: str) -> None:
    """
    Append one JSON line to the audit log file.

    `record` must already contain:
      input_id, language, rule_score, semantic_score, pii_entities,
      final_risk, decision, reason_codes, latency_ms
    """
    # Make sure the folder exists (first run after a fresh clone)
    folder = os.path.dirname(log_path)
    if folder and not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)

    # Add a timestamp so we can sort/filter later
    record_with_time = dict(record)
    record_with_time["timestamp"] = datetime.utcnow().isoformat() + "Z"

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record_with_time, ensure_ascii=False) + "\n")


def read_recent(log_path: str, limit: int = 100) -> list:
    """Read the last `limit` log entries (used by /metrics)."""
    if not os.path.exists(log_path):
        return []
    with open(log_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    recent = lines[-limit:]
    entries = []
    for line in recent:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries
