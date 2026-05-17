"""
Semantic injection detector.

We use TF-IDF character n-grams (2-5) + Logistic Regression. Char n-grams
work across English, Urdu, and Korean without needing a tokenizer per
language, and the whole pipeline is small enough to train in seconds on
a CPU.

This file has two roles:
  1. As a library: `load_model()` + `score_semantic()` for the gateway.
  2. As a script:  `python -m app.detectors.semantic_detector` trains the
                   model from data/train_injection.csv and writes the
                   pickle to results/semantic_model.pkl.
"""

import os
import sys
import pickle
from typing import Optional

# We import sklearn lazily inside functions so the gateway can run even
# when sklearn is not installed (it will just skip the semantic detector).


def train_and_save(csv_path: str, model_path: str) -> None:
    """Fit the TF-IDF + LogReg pipeline on `csv_path` and save it to `model_path`."""
    import pandas as pd
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline

    df = pd.read_csv(csv_path)
    if "text" not in df.columns or "label" not in df.columns:
        raise ValueError("training csv must have columns: text,label")

    texts = df["text"].astype(str).tolist()
    labels = df["label"].astype(int).tolist()

    pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(
            analyzer="char_wb",     # char n-grams within word boundaries (multilingual safe)
            ngram_range=(2, 5),
            min_df=1,
            max_df=0.95,
            sublinear_tf=True,
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            C=2.0,
            class_weight="balanced",
        )),
    ])

    pipeline.fit(texts, labels)

    # Make sure the output folder exists
    folder = os.path.dirname(model_path)
    if folder and not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)

    with open(model_path, "wb") as f:
        pickle.dump(pipeline, f)

    # Quick training-set accuracy print for sanity
    acc = pipeline.score(texts, labels)
    print(f"Trained on {len(texts)} rows. Training accuracy: {acc:.3f}")
    print(f"Saved model to {model_path}")


def load_model(model_path: str):
    """Load the pickled pipeline. Returns None if the file is missing."""
    if not os.path.exists(model_path):
        return None
    with open(model_path, "rb") as f:
        return pickle.load(f)


def score_semantic(model, text: str) -> float:
    """
    Return the model's probability that `text` is an injection (class 1).
    If model is None, return 0.0 so the gateway can still run.
    """
    if model is None:
        return 0.0
    prob = model.predict_proba([text])[0]
    # class_ order is [0, 1] after sklearn fit, but be defensive
    try:
        idx = list(model.classes_).index(1)
    except ValueError:
        return 0.0
    return round(float(prob[idx]), 3)


# Allow running as a script:   python -m app.detectors.semantic_detector
if __name__ == "__main__":
    # Default paths used by the project
    csv = sys.argv[1] if len(sys.argv) > 1 else "data/train_injection.csv"
    out = sys.argv[2] if len(sys.argv) > 2 else "results/semantic_model.pkl"
    train_and_save(csv, out)
