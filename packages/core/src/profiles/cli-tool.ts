import { basicProfile } from './basic.js';

export const cliTool = basicProfile({
  id: 'cli-tool',
  label: 'Command-line tool',
  signalWords: [
    'cli', 'command line', 'command-line', 'terminal', 'script', 'shell script', 'renamer',
    'renames', 'rename', 'git helper', 'automation',
  ],
  layers: [
    ['language', 'Language', 'Foundation', 'The language the tool is written in.'],
    ['argument-parsing', 'Argument parsing', 'Interface', 'How flags and arguments are read.'],
    ['packaging', 'Packaging', 'Ship', 'How the tool is installed and run.'],
    ['testing', 'Testing', 'Quality', 'Golden runs of the command with known input.'],
  ],
  requiredLayersByTier: {
    T1: ['language'],
    T2: ['language', 'argument-parsing'],
    T3: ['language', 'argument-parsing', 'packaging', 'testing'],
    T4: ['language', 'argument-parsing', 'packaging', 'testing'],
    T5: ['language', 'argument-parsing', 'packaging', 'testing'],
  },
  rule: 'Input and output happen only at the edges; the logic in between is pure.',
  harnesses: ['exec-golden', 'unit'],
  browser: true,
});
