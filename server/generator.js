import { solveAll, treeToString, treeToTokens, hintsFor } from '../shared/solver.js';
import { TARGET_MIN, TARGET_MAX } from './config.js';

const randDigit = () => Math.floor(Math.random() * 10);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Deal five random digits and a target that is provably reachable using all five of them.
// An optional {targetMin, targetMax} narrows the target range for difficulty modes.
export function generatePuzzle({ targetMin = TARGET_MIN, targetMax = TARGET_MAX } = {}) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const digits = Array.from({ length: 5 }, randDigit);
    const solutions = solveAll(digits);
    const targets = [...solutions.keys()].filter((n) => n >= targetMin && n <= targetMax);
    if (targets.length === 0) continue;
    const target = pick(targets);
    const trees = solutions.get(target);
    const key = pick(trees);
    return {
      digits,
      target,
      keySolution: treeToString(key),
      keyTokens: treeToTokens(key),
      solutions: trees,
      altSolutions: trees.map(treeToString),
    };
  }
  throw new Error('Could not generate a solvable puzzle');
}

export { hintsFor };
