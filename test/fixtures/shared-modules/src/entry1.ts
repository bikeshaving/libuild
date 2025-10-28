import { sharedUtility, expensiveOperation } from './shared.js';

export function entry1Function() {
  return `Entry 1: ${sharedUtility} - ${expensiveOperation()}`;
}

export const entry1Data = "Entry 1 specific data";