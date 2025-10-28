import { sharedUtility, SharedClass } from './shared.js';

export function entry2Function() {
  const instance = new SharedClass("Entry 2");
  return `Entry 2: ${sharedUtility} - ${instance.greet()}`;
}

export const entry2Data = "Entry 2 specific data";