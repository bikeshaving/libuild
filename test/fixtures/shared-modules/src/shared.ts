export const sharedUtility = "This is a shared utility function";

export function expensiveOperation() {
  // Simulate a larger shared module
  const data = Array.from({length: 100}, (_, i) => `item-${i}`);
  return data.join('-');
}

export class SharedClass {
  constructor(public name: string) {}
  
  greet() {
    return `Hello from ${this.name}`;
  }
}