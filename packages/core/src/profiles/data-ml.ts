import { basicProfile } from './basic.js';

export const dataMl = basicProfile({
  id: 'data-ml',
  label: 'Data or machine learning',
  signalWords: [
    'machine learning', 'ml', 'classifier', 'neural network', 'model training', 'etl', 'data pipeline',
    'pandas', 'scikit-learn', 'pytorch', 'tensorflow', 'dataset', 'data analysis', 'regression',
  ],
  layers: [
    ['language', 'Language', 'Foundation', 'Usually Python.'],
    ['storage', 'Storage', 'Data', 'Where the data comes from and is kept.'],
    ['processing', 'Processing library', 'Core', 'pandas, Polars or plain Python.'],
    ['model-library', 'Model library', 'Core', 'scikit-learn, PyTorch or none.'],
    ['tracking', 'Experiment tracking', 'Tools', 'How runs and metrics are recorded.'],
    ['serving', 'Serving', 'Ship', 'How results or the model are used.'],
    ['testing', 'Testing', 'Quality', 'Unit tests and metrics within a tolerance.'],
  ],
  requiredLayersByTier: {
    T1: ['language', 'processing'],
    T2: ['language', 'storage', 'processing', 'testing'],
    T3: ['language', 'storage', 'processing', 'model-library', 'testing'],
    T4: ['language', 'storage', 'processing', 'model-library', 'tracking', 'serving', 'testing'],
    T5: ['language', 'storage', 'processing', 'model-library', 'tracking', 'serving', 'testing'],
  },
  rule: 'Seeded, small datasets checked in.',
  harnesses: ['unit'],
});
