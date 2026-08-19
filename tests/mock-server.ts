import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockRequest = {
  method: string;
  url: URL;
  pathname: string;
  authorization: string | undefined;
};

export type MockReply = {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

export type MockHandler = (req: MockRequest) => MockReply | Promise<MockReply>;

export type StartedMock = {
  baseUrl: string;
  close: () => Promise<void>;
};

function readAuthorization(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function writeReply(res: ServerResponse, reply: MockReply): void {
  const status = reply.status ?? 200;
  const headers = { ...reply.headers };
  if (reply.json !== undefined) {
    const body = JSON.stringify(reply.json);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(body);
    return;
  }
  res.writeHead(status, headers);
  res.end(reply.text ?? "");
}

export function startMockServer(handler: MockHandler): Promise<StartedMock> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const reply = await handler({
          method: (req.method ?? "GET").toUpperCase(),
          url,
          pathname: url.pathname,
          authorization: readAuthorization(req),
        });
        writeReply(res, reply);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeReply(res, { status: 500, json: { error: message } });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
