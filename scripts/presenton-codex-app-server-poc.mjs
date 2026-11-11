import { spawn } from "node:child_process";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  out: { type: "string", default: "/tmp/presenton-codex-poc" },
  model: { type: "string", default: "gpt-6.1-sol" },
} });
const outputDirectory = path.resolve(values.out);
await mkdir(outputDirectory, { recursive: true });
const environment = { ...process.env };
delete environment.OPENAI_API_KEY;
delete environment.CODEX_API_KEY;
const server = spawn("codex", ["app-server", "-c", "mcp_servers={}", "-c", 'web_search="live"'], {
  env: environment, stdio: ["pipe", "pipe", "pipe"],
});
// Server diagnostics can contain local context. Keep the public result to the
// explicit verification fields below, and surface only RPC errors to callers.
server.stderr.resume();
const pending = new Map();
let nextId = 0;
let finishTurn;
let rejectTurn;
let turnTimer;
const searchEvents = [];
const imageEvents = [];
const messages = [];
const completed = new Promise((resolve, reject) => { finishTurn = resolve; rejectTurn = reject; });
// Register a rejection handler immediately, before asynchronous initialization.
completed.catch(() => {});

function send(message) {
  server.stdin.write(JSON.stringify(message) + "\n");
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 120_000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    send({ id, method, params });
  });
}
const lines = createInterface({ input: server.stdout });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
    return;
  }
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: "Interactive requests are unsupported in this verification client" } });
    return;
  }
  const item = message.params?.item;
  if (message.method === "item/completed" && item) {
    if (item.type === "webSearch") searchEvents.push({ query: item.query, action: item.action });
    if (item.type === "imageGeneration") imageEvents.push({ status: item.status, savedPath: item.savedPath, failure: item.failure });
    if (item.type === "agentMessage") messages.push(item.text);
    if (["webSearch", "imageGeneration"].includes(item.type)) {
      console.log(JSON.stringify({ event: item.type, status: item.status ?? "completed" }));
    }
  }
  if (message.method === "turn/completed") {
    const turn = message.params.turn;
    if (turn.status === "completed") finishTurn(turn);
    else rejectTurn(new Error(turn.error?.message ?? "Turn finished with status " + turn.status));
  }
});
server.on("error", rejectTurn);
server.on("exit", code => {
  for (const call of pending.values()) call.reject(new Error("App Server exited with code " + code));
  pending.clear();
  rejectTurn(new Error("App Server exited with code " + code));
});

try {
  await request("initialize", { clientInfo: { name: "presenton-codex-poc", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  const account = await request("account/read", { refreshToken: false });
  if (account.account?.type !== "chatgpt") throw new Error("A Codex-managed ChatGPT login is required");
  const thread = await request("thread/start", {
    model: values.model, cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
  });
  turnTimer = setTimeout(() => rejectTurn(new Error("Generation timed out after 20 minutes")), 20 * 60_000);
  await request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "Presentonの1枚編集PoC用の素材を作ってください。組み込みのWeb検索を使い、RFC 2606がexample.comなどを文書の例示用に予約していることを公式資料で確認してください。短い日本語のタイトルと本文、公式出典URLを作ってください。次に組み込みImageGenでPNGを1枚だけ生成してください。画像は文書の例示用ドメインをテーマに、白地に青と緑で文書・地球・リンクを描くシンプルな図解です。文字とロゴは入れません。画像生成ツールの完了と保存先を確認してください。シェル、外部MCP、Images APIは使用しません。リポジトリのコードは変更しません。最後にtitle、body、source_url、image_pathだけをJSONで返してください。" }],
    outputSchema: { type: "object", additionalProperties: false, required: ["title", "body", "source_url", "image_path"], properties: {
      title: { type: "string" }, body: { type: "string" }, source_url: { type: "string" }, image_path: { type: "string" },
    } },
  });
  await completed;
  const generated = JSON.parse(messages.at(-1));
  if (!searchEvents.length) throw new Error("No completed Web search event was observed");
  const image = imageEvents.find(item => item.status === "completed" && item.savedPath);
  if (!image) throw new Error("No completed ImageGen PNG was observed");
  const source = new URL(generated.source_url);
  if (source.protocol !== "https:" || !["www.rfc-editor.org", "rfc-editor.org", "www.ietf.org", "datatracker.ietf.org"].includes(source.hostname)) {
    throw new Error("An official RFC source URL is required");
  }
  const png = await readFile(image.savedPath);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("ImageGen did not save a PNG");
  const pngPath = path.join(outputDirectory, "image.png");
  await copyFile(image.savedPath, pngPath);
  const result = {
    ...generated, image_path: pngPath,
    verification: { account_type: account.account.type, plan_type: account.account.planType, model: values.model,
      search_events: searchEvents, image_events: imageEvents.map(({ status, savedPath }) => ({ status, savedPath })) },
  };
  await writeFile(path.join(outputDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ result: path.join(outputDirectory, "result.json"), image: pngPath, source: source.href }));
} finally {
  clearTimeout(turnTimer);
  lines.close();
  server.stdin.end();
  server.kill("SIGTERM");
}
