// @types/supertest суулгаагүй (dep нэмэхгүй) тул тестэд хэрэглэгдэх хамгийн бага ambient төрөл.
declare module 'supertest' {
  interface Test extends PromiseLike<Response> {
    set(field: string, value: string): Test;
    set(fields: Record<string, string>): Test;
    send(body?: unknown): Test;
    query(q: Record<string, unknown> | string): Test;
  }
  interface Response {
    status: number;
    body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    text: string;
    headers: Record<string, string>;
  }
  interface Agent {
    get(url: string): Test;
    post(url: string): Test;
    patch(url: string): Test;
    put(url: string): Test;
    delete(url: string): Test;
  }
  function request(app: unknown): Agent;
  export = request;
}
