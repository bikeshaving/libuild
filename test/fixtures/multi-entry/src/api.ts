export default class Api {
  constructor(private baseUrl: string) {}
  
  async get(path: string): Promise<any> {
    return fetch(`${this.baseUrl}${path}`).then(r => r.json());
  }
}