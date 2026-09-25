import Link from "next/link";
import { METRICS, PLANS, eur } from "@/lib/catalog";

export const metadata = { title: "nebula.ai API · Documentation (demo)" };

const BASE = "http://localhost:3000/api/v1";
const Code = ({ children }: { children: string }) => <pre tabIndex={0}><code>{children}</code></pre>;

export default function Docs() {
  return (
    <main className="wrap docs">
      <h1 style={{ fontSize: 32, letterSpacing: "-.02em", margin: "0 0 6px" }}>nebula.ai API</h1>
      <p className="muted" style={{ marginTop: 0 }}>A fictional API for this demo: responses are simulated, but usage is recorded and billed for real on your account (simulated mode or live Metronome).</p>
      <div className="docsgrid">
        <nav className="toc" aria-label="Documentation contents">
          <a href="#auth">Authentication</a><a href="#completions">Text: /completions</a><a href="#images">Images: /images</a>
          <a href="#billing">How it is billed</a><a href="#idempotency">Idempotency</a><a href="#errors">Errors</a><a href="#limits">Limits</a>
        </nav>
        <div>
          <section aria-labelledby="auth">
            <h2 id="auth">Authentication</h2>
            <p>Create a key under <Link href="/keys"><u>API keys</u></Link> and send it with every request. Keys start with <code>nbl_test_</code> (simulated mode) or <code>nbl_live_</code> (live mode), are shown only once and can be revoked at any time.</p>
            <Code>{`Authorization: Bearer nbl_test_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Content-Type: application/json`}</Code>
            <p>Base URL in this demo: <code>{BASE}</code>. The <code>X-API-Key</code> header is also accepted.</p>
          </section>

          <section aria-labelledby="completions">
            <h2 id="completions"><span className="method">POST</span>/completions</h2>
            <p>Generates text with the <code>nebula-1</code> model.</p>
            <dl className="kv">
              <dt><code>prompt</code></dt><dd>Input text (required, max 200,000 characters).</dd>
              <dt><code>max_tokens</code></dt><dd>Output tokens, integer from 1 to 4096 (default 256).</dd>
              <dt><code>model</code></dt><dd>Optional; only <code>nebula-1</code>.</dd>
            </dl>
            <h3>Request</h3>
            <Code>{`curl ${BASE}/completions \\
  -H "Authorization: Bearer $NEBULA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1234" \\
  -d '{"prompt": "Summarize this text in three sentences…", "max_tokens": 200}'`}</Code>
            <h3>Response <span className="badge ok">200</span></h3>
            <Code>{`{
  "id": "idem_order-1234",
  "object": "text_completion",
  "created": 1790000000,
  "model": "nebula-1",
  "choices": [{ "index": 0, "text": "This is a simulated nebula-1 response…", "finish_reason": "length" }],
  "usage": { "input_tokens": 10, "output_tokens": 200 },
  "billing": { "request_id": "idem_order-1234", "cost_eur": 0.0015, "balance_eur": 29.99, "replayed": false }
}`}</Code>
          </section>

          <section aria-labelledby="images">
            <h2 id="images"><span className="method">POST</span>/images</h2>
            <p>Generates images with <code>nebula-image-1</code>.</p>
            <dl className="kv">
              <dt><code>prompt</code></dt><dd>Image description (required).</dd>
              <dt><code>n</code></dt><dd>Number of images, 1 to 10 (default 1).</dd>
              <dt><code>size</code></dt><dd><code>512x512</code> or <code>1024x1024</code> (same price).</dd>
            </dl>
            <h3>Request</h3>
            <Code>{`curl ${BASE}/images \\
  -H "Authorization: Bearer $NEBULA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "A lighthouse at sunset, watercolor", "n": 2}'`}</Code>
            <h3>Response <span className="badge ok">200</span></h3>
            <Code>{`{
  "id": "req_5f0c…",
  "object": "image_generation",
  "model": "nebula-image-1",
  "data": [
    { "url": "https://img.nebula.example/req_5f0c…/0.png", "size": "1024x1024" },
    { "url": "https://img.nebula.example/req_5f0c…/1.png", "size": "1024x1024" }
  ],
  "usage": { "images": 2 },
  "billing": { "request_id": "req_5f0c…", "cost_eur": 0.072, "balance_eur": 29.92, "replayed": false }
}`}</Code>
          </section>

          <section aria-labelledby="billing">
            <h2 id="billing">How each request is billed</h2>
            <p>Every accepted request is sent to Metronome (<code>POST /v1/ingest</code>) with its id as the <code>transaction_id</code>. List prices get your plan discount (Free 0%, Pro {PLANS.pro.discount * 100}%, Scale {PLANS.scale.discount * 100}%) and are deducted from your credits.</p>
            <div className="tablewrap" tabIndex={0}><table>
              <caption className="sr-only">Mapping between endpoints and billable metrics</caption>
              <thead><tr><th scope="col">Endpoint</th><th scope="col">Metronome event</th><th scope="col">Billable metric</th><th scope="col">Quantity</th><th scope="col">List price</th></tr></thead>
              <tbody>
                <tr><td rowSpan={2}><code>/completions</code></td><td rowSpan={2}><code>nebula_llm_request</code></td><td>{METRICS.input_tokens.name}</td><td>≈ prompt characters ÷ 4</td><td>{METRICS.input_tokens.display}</td></tr>
                <tr><td>{METRICS.output_tokens.name}</td><td><code>max_tokens</code> (the simulated response always uses them all)</td><td>{METRICS.output_tokens.display}</td></tr>
                <tr><td><code>/images</code></td><td><code>nebula_image_generation</code></td><td>{METRICS.images.name}</td><td><code>n</code></td><td>{METRICS.images.display}</td></tr>
              </tbody>
            </table></div>
            <p>Example on Pro: a 4,000-character prompt (1,000 tokens) with <code>max_tokens: 500</code> costs (1,000 × 2 + 500 × 8) / 1,000,000 × 0.9 = {eur(0.0054)}.</p>
            <p>Usage shows up immediately under <Link href="/dashboard"><u>Usage</u></Link> (30-day chart, next invoice and latest requests, with their ids).</p>
          </section>

          <section aria-labelledby="idempotency">
            <h2 id="idempotency">Idempotency</h2>
            <p>Send <code>Idempotency-Key</code> (1–100 characters <code>A-Z a-z 0-9 _ . : -</code>) to retry safely: a repeat returns the same response with <code>Idempotent-Replayed: true</code> and <code>cost_eur: 0</code>, and is never billed twice (Metronome deduplicates by <code>transaction_id</code> for 34 days). Without the header, every request gets a new id (<code>X-Request-Id</code>).</p>
          </section>

          <section aria-labelledby="errors">
            <h2 id="errors">Errors</h2>
            <div className="tablewrap" tabIndex={0}><table>
              <caption className="sr-only">Error codes</caption>
              <thead><tr><th scope="col">HTTP</th><th scope="col"><code>error.type</code></th><th scope="col">When</th></tr></thead>
              <tbody>
                <tr><td>400</td><td><code>invalid_request_error</code></td><td>Invalid JSON, missing <code>prompt</code>, out-of-range parameters or unknown model.</td></tr>
                <tr><td>401</td><td><code>authentication_error</code></td><td>Key missing, malformed or revoked.</td></tr>
                <tr><td>402</td><td><code>insufficient_balance</code></td><td>Balance used up on Free/Pro (access pauses until you top up or upgrade).</td></tr>
                <tr><td>402</td><td><code>spend_limit_reached</code></td><td>The request would exceed your monthly spend limit (set it under Billing).</td></tr>
              </tbody>
            </table></div>
            <Code>{`HTTP/1.1 402 Payment Required
{ "error": { "type": "spend_limit_reached", "message": "You've reached your monthly spend limit…", "spend_cap_eur": 50 } }`}</Code>
          </section>

          <section aria-labelledby="limits">
            <h2 id="limits">Limits</h2>
            <ul>
              <li>Optional monthly spend limit: alert at 80% and <code>402</code> once reached.</li>
              <li>Free and Pro don&apos;t allow usage beyond your balance; Scale bills overage at month end (with an early charge on spikes).</li>
              <li>No per-second rate limit in this demo (production would rate-limit per key).</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
