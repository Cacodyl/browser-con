import { createServer } from 'node:http';
export async function serveFixture() {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Brocon local form</title><h1>Contact form</h1>
      <form><label>Name <input name="name" required></label>
      <label>Topic <select name="topic"><option value="support">Support</option><option value="demo">Demo</option></select></label>
      <button>Send</button></form><p id="result"></p>
      <script>document.querySelector('form').onsubmit = event => { event.preventDefault(); const form = event.target; document.querySelector('#result').textContent = 'Submitted: ' + form.elements.name.value + ' / ' + form.elements.topic.value; };</script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture startup failed');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
