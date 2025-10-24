export function createWidget(name: string): { name: string, id: string } {
  return {
    name,
    id: Math.random().toString(36)
  };
}