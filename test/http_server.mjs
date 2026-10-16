// A tiny HTTP server for testing runner/bridge.mjs's curl calls. Run as a child process; prints its port.
import http from 'node:http';

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const send = (code, text, headers = {}) => { res.writeHead(code, {'Content-Type': 'application/json', ...headers}); res.end(text); };
    if (req.url === '/echo') return send(200, JSON.stringify({method: req.method, headers: req.headers, body}));
    if (req.url === '/redirect') return send(302, '', {Location: '/landing'});
    if (req.url === '/landing') return send(200, JSON.stringify({method: req.method, body}));
    if (req.url === '/fail') return send(500, 'oops');
    return send(404, '{}');
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
