/**
 * Semantic injection detector: TF-IDF over character n-grams, then logistic
 * regression.
 *
 * Character n-grams (2 to 5, inside word boundaries) work across English, Urdu
 * and Korean without a tokenizer per language, and the model trains in a
 * fraction of a second, so it is trained from `data/train_injection.csv` at
 * startup instead of being shipped as a file.
 *
 * This reproduces the Python gateway's scikit-learn pipeline:
 *
 *   TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=1,
 *                   max_df=0.95, sublinear_tf=True)
 *   LogisticRegression(C=2.0, class_weight="balanced")
 *
 * The vectorizer follows scikit-learn's arithmetic exactly. The regression is
 * solved to convergence, where scikit-learn's solver stops a little short of
 * it; on the 514 prompts the port was checked against, the two models'
 * probabilities differ by at most 0.0021.
 */

import { pySplit } from './pyre.js';

export interface TrainingRow {
  text: string;
  label: 0 | 1;
}

export interface SemanticModel {
  vocabulary: Map<string, number>;
  idf: Float64Array;
  weights: Float64Array;
  bias: number;
}

const MIN_N = 2;
const MAX_N = 5;
const MAX_DF = 0.95;
const C = 2;

/** scikit-learn's `char_wb` analyzer: lowercased, each word padded with one space. */
export function charWbNgrams(text: string): string[] {
  const ngrams: string[] = [];
  for (const word of pySplit(text.toLowerCase())) {
    // Code points, not UTF-16 units, as Python indexes strings.
    const chars = Array.from(` ${word} `);
    for (let n = MIN_N; n <= MAX_N; n++) {
      let offset = 0;
      ngrams.push(chars.slice(0, n).join(''));
      while (offset + n < chars.length) {
        offset++;
        ngrams.push(chars.slice(offset, offset + n).join(''));
      }
      // The word was no longer than n, so it has just given its only n-gram.
      if (offset === 0) break;
    }
  }
  return ngrams;
}

function countTerms(text: string, vocabulary?: Map<string, number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const gram of charWbNgrams(text)) {
    if (vocabulary && !vocabulary.has(gram)) continue;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

interface SparseRow {
  indices: number[];
  values: number[];
}

/** Sublinear tf times idf, L2-normalised. */
function tfidfRow(counts: Map<string, number>, vocabulary: Map<string, number>, idf: Float64Array): SparseRow {
  const indices: number[] = [];
  const values: number[] = [];
  let norm = 0;
  for (const [gram, count] of counts) {
    const index = vocabulary.get(gram)!;
    const value = (1 + Math.log(count)) * idf[index]!;
    indices.push(index);
    values.push(value);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < values.length; i++) values[i]! /= norm;
  return { indices, values };
}

export function trainSemanticModel(rows: TrainingRow[]): SemanticModel {
  const docs = rows.map((row) => countTerms(row.text));

  const df = new Map<string, number>();
  for (const doc of docs) for (const gram of doc.keys()) df.set(gram, (df.get(gram) ?? 0) + 1);

  const vocabulary = new Map<string, number>();
  const maxDocs = MAX_DF * rows.length;
  for (const [gram, count] of df) if (count <= maxDocs) vocabulary.set(gram, vocabulary.size);

  // Smoothed idf: as if one extra document contained every term once.
  const idf = new Float64Array(vocabulary.size);
  for (const [gram, index] of vocabulary) idf[index] = Math.log((1 + rows.length) / (1 + df.get(gram)!)) + 1;

  const X = docs.map((doc) => {
    for (const gram of doc.keys()) if (!vocabulary.has(gram)) doc.delete(gram);
    return tfidfRow(doc, vocabulary, idf);
  });
  const y = rows.map((row) => row.label);

  // "balanced": each class weighs in inverse proportion to its size.
  const positives = y.filter((label) => label === 1).length;
  const classWeight = [rows.length / (2 * (rows.length - positives)), rows.length / (2 * positives)];
  const sampleWeight = y.map((label) => classWeight[label]!);

  const { weights, bias } = fitLogistic(X, y, sampleWeight, vocabulary.size);
  return { vocabulary, idf, weights, bias };
}

/** The model's probability that `text` is an injection. */
export function semanticProbability(model: SemanticModel, text: string): number {
  const row = tfidfRow(countTerms(text, model.vocabulary), model.vocabulary, model.idf);
  let z = model.bias;
  for (let i = 0; i < row.indices.length; i++) z += row.values[i]! * model.weights[row.indices[i]!]!;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Minimises Σ sᵢ·log(1 + e^(−mᵢ)) + ‖w‖²/(2C), where mᵢ is the signed margin
 * and the intercept is not penalised: scikit-learn's objective. Solved with
 * L-BFGS, as scikit-learn does, but run until the gradient all but vanishes.
 */
function fitLogistic(X: SparseRow[], y: number[], sampleWeight: number[], dims: number) {
  const size = dims + 1; // the last slot is the intercept
  const memory = 10;
  const maxIterations = 1000;
  const tolerance = 1e-8;

  const evaluate = (theta: Float64Array): { loss: number; grad: Float64Array } => {
    const grad = new Float64Array(size);
    let loss = 0;
    for (let i = 0; i < X.length; i++) {
      const { indices, values } = X[i]!;
      let z = theta[dims]!;
      for (let k = 0; k < indices.length; k++) z += values[k]! * theta[indices[k]!]!;
      const margin = y[i] === 1 ? z : -z;
      // log(1 + e^−m) without overflow for large |m|.
      loss += sampleWeight[i]! * (margin > 0 ? Math.log1p(Math.exp(-margin)) : -margin + Math.log1p(Math.exp(margin)));
      const residual = sampleWeight[i]! * (1 / (1 + Math.exp(-z)) - y[i]!);
      for (let k = 0; k < indices.length; k++) grad[indices[k]!]! += residual * values[k]!;
      grad[dims]! += residual;
    }
    for (let j = 0; j < dims; j++) {
      loss += (theta[j]! * theta[j]!) / (2 * C);
      grad[j]! += theta[j]! / C;
    }
    return { loss, grad };
  };

  const dot = (a: Float64Array, b: Float64Array) => {
    let total = 0;
    for (let j = 0; j < size; j++) total += a[j]! * b[j]!;
    return total;
  };

  let theta: Float64Array = new Float64Array(size);
  let current = evaluate(theta);
  const steps: Float64Array[] = [];
  const changes: Float64Array[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (current.grad.every((g) => Math.abs(g) < tolerance)) break;

    // Two-loop recursion: direction = −H·∇ from the stored curvature pairs.
    const direction = Float64Array.from(current.grad);
    const alphas: number[] = [];
    for (let m = steps.length - 1; m >= 0; m--) {
      alphas[m] = dot(steps[m]!, direction) / dot(changes[m]!, steps[m]!);
      for (let j = 0; j < size; j++) direction[j]! -= alphas[m]! * changes[m]![j]!;
    }
    if (steps.length > 0) {
      const last = steps.length - 1;
      const gamma = dot(steps[last]!, changes[last]!) / dot(changes[last]!, changes[last]!);
      for (let j = 0; j < size; j++) direction[j]! *= gamma;
    }
    for (let m = 0; m < steps.length; m++) {
      const beta = dot(changes[m]!, direction) / dot(changes[m]!, steps[m]!);
      for (let j = 0; j < size; j++) direction[j]! += steps[m]![j]! * (alphas[m]! - beta);
    }
    for (let j = 0; j < size; j++) direction[j] = -direction[j]!;

    // Backtracking line search to the Armijo condition.
    const slope = dot(current.grad, direction);
    let accepted: { theta: Float64Array; loss: number; grad: Float64Array } | null = null;
    for (let stepSize = 1; stepSize >= 1e-12; stepSize /= 2) {
      const next = theta.map((value, j) => value + stepSize * direction[j]!);
      const trial = evaluate(next);
      if (trial.loss <= current.loss + 1e-4 * stepSize * slope) {
        accepted = { theta: next, ...trial };
        break;
      }
    }
    if (!accepted) break;
    // scipy's stopping rule, with the tolerance scikit-learn gives it: past
    // this, the improvement is lost in the loss's rounding error.
    const improvement = current.loss - accepted.loss;
    if (improvement <= 64 * Number.EPSILON * Math.max(Math.abs(current.loss), Math.abs(accepted.loss), 1)) {
      theta = accepted.theta;
      break;
    }

    const step = accepted.theta.map((value, j) => value - theta[j]!);
    const change = accepted.grad.map((value, j) => value - current.grad[j]!);
    if (dot(step, change) > 1e-12) {
      steps.push(step);
      changes.push(change);
      if (steps.length > memory) {
        steps.shift();
        changes.shift();
      }
    }
    theta = accepted.theta;
    current = accepted;
  }

  return { weights: theta.subarray(0, dims), bias: theta[dims]! };
}
