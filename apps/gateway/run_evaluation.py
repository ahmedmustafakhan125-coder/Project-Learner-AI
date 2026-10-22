"""
Reproducible evaluation script.

Runs every prompt in data/final_eval.csv through the gateway twice:
  1. Rule-only baseline   (semantic detector disabled)
  2. Hybrid (rule + semantic)

Outputs:
  results/evaluation_results.csv  - one row per prompt per mode
  results/metrics_summary.json    - accuracy / precision / recall / F1 +
                                    per-language recall + latency stats
  results/audit_log.jsonl         - appended automatically by the pipeline

Usage:
  python run_evaluation.py
"""

import csv
import json
import os
import statistics
import sys
from collections import defaultdict

import yaml

# Make the `app` package importable when running this from project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.detectors import semantic_detector
from app.main import run_pipeline


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def normalise_decision(d: str) -> str:
    """Treat FLAG (if it ever appears) like ALLOW for grading."""
    if d == "FLAG":
        return "ALLOW"
    return d


def precision_recall_f1(tp: int, fp: int, fn: int) -> tuple:
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return round(prec, 3), round(rec, 3), round(f1, 3)


def evaluate_mode(rows: list, model, use_semantic: bool, mode_name: str) -> dict:
    """Run every row through the pipeline and compute metrics."""
    correct = 0
    total = 0
    latencies = []

    # Confusion-matrix counts on the BLOCK class (most important class).
    tp = fp = fn = tn = 0

    # Per-language correctness (recall on attack rows)
    lang_total = defaultdict(int)
    lang_correct = defaultdict(int)

    out_rows = []

    for row in rows:
        prompt = row["prompt"]
        expected = normalise_decision(row["expected_policy"])

        try:
            result = run_pipeline(prompt, row["id"], model, use_semantic=use_semantic)
        except Exception as e:
            # Record the error but keep going so one bad row does not stop eval.
            out_rows.append({
                **row,
                "mode": mode_name,
                "got_decision": "ERROR",
                "rule_score": "",
                "semantic_score": "",
                "final_risk": "",
                "latency_ms": "",
                "error": str(e),
            })
            total += 1
            continue

        got = result["decision"]
        latencies.append(result["latency_ms"])

        # Overall accuracy
        total += 1
        if got == expected:
            correct += 1

        # BLOCK-class confusion
        is_block_expected = (expected == "BLOCK")
        is_block_got = (got == "BLOCK")
        if is_block_expected and is_block_got: tp += 1
        elif (not is_block_expected) and is_block_got: fp += 1
        elif is_block_expected and (not is_block_got): fn += 1
        else: tn += 1

        # Per-language recall (only on BLOCK rows)
        if is_block_expected:
            lang_total[row["language"]] += 1
            if is_block_got:
                lang_correct[row["language"]] += 1

        out_rows.append({
            **row,
            "mode": mode_name,
            "got_decision": got,
            "rule_score": result["rule_score"],
            "semantic_score": result["semantic_score"],
            "final_risk": result["final_risk"],
            "latency_ms": result["latency_ms"],
            "error": "",
        })

    prec, rec, f1 = precision_recall_f1(tp, fp, fn)
    accuracy = round(correct / total, 3) if total else 0.0

    per_lang = {}
    for lang in lang_total:
        per_lang[lang] = {
            "total_attacks": lang_total[lang],
            "blocked": lang_correct[lang],
            "recall": round(lang_correct[lang] / lang_total[lang], 3) if lang_total[lang] else 0.0,
        }

    lat_sorted = sorted(latencies)
    n = len(lat_sorted)
    metrics = {
        "mode": mode_name,
        "total": total,
        "correct": correct,
        "accuracy": accuracy,
        "block_class": {
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": prec, "recall": rec, "f1": f1,
        },
        "per_language": per_lang,
        "latency_ms": {
            "mean": round(statistics.mean(latencies), 2) if latencies else 0,
            "median": round(statistics.median(latencies), 2) if latencies else 0,
            "p95": round(lat_sorted[max(0, int(0.95 * n) - 1)], 2) if latencies else 0,
        },
    }

    return {"rows": out_rows, "metrics": metrics}


def main():
    config = load_config("config/gateway_config.yaml")
    eval_path = config["paths"]["evaluation_data"]
    model_path = config["paths"]["semantic_model"]

    # Load data
    with open(eval_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print(f"[eval] loaded {len(rows)} prompts from {eval_path}")

    # Train (or just load) the semantic model
    if not os.path.exists(model_path):
        print(f"[eval] semantic model not found, training from {config['paths']['training_data']}")
        semantic_detector.train_and_save(config["paths"]["training_data"], model_path)
    model = semantic_detector.load_model(model_path)
    print(f"[eval] semantic model loaded: {model is not None}")

    # Need Presidio loaded before the first call
    from app.pii.presidio_custom import get_engine
    get_engine()

    # Mode 1: rule-only (baseline)
    print("\n[eval] Running RULE_ONLY ...")
    rule_only = evaluate_mode(rows, model, use_semantic=False, mode_name="rule_only")

    # Mode 2: hybrid (rule + semantic)
    print("[eval] Running HYBRID ...")
    hybrid = evaluate_mode(rows, model, use_semantic=True, mode_name="hybrid")

    # Write per-prompt results
    os.makedirs("results", exist_ok=True)
    out_csv = "results/evaluation_results.csv"
    all_rows = rule_only["rows"] + hybrid["rows"]
    fieldnames = list(all_rows[0].keys())
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"[eval] wrote {out_csv}")

    # Write summary
    summary = {
        "rule_only": rule_only["metrics"],
        "hybrid": hybrid["metrics"],
    }
    with open("results/metrics_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print("[eval] wrote results/metrics_summary.json")

    # Console table
    print("\n=== Summary ===")
    for name, m in summary.items():
        b = m["block_class"]
        print(f"{name:10s} | acc={m['accuracy']:.3f}  P={b['precision']:.3f}  "
              f"R={b['recall']:.3f}  F1={b['f1']:.3f}  "
              f"mean_ms={m['latency_ms']['mean']}")
    print("\nPer-language recall (hybrid):")
    for lang, vals in hybrid["metrics"]["per_language"].items():
        print(f"  {lang}: {vals['blocked']}/{vals['total_attacks']} = {vals['recall']:.3f}")


if __name__ == "__main__":
    main()
