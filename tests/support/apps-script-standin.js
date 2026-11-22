'use strict';

/*
 * Local stand-in for the deployed Apps Script web app: runs dist/apps-script/Code.gs on fake Google
 * services and answers the way /exec does (text/plain POST, JSON body, CORS for any origin, no
 * preflight support). Used to try the website's Apps Script mode without a Google account.
 *
 *   node tests/support/apps-script-standin.js [port]     then set leadsEndpoint to http://127.0.0.1:<port>/exec
 */

const http = require('node:http');
const { loadAppsScript } = require('./gas-fakes');

function startStandin(port = 0) {
  const script = loadAppsScript({ ownerEmail: 'admin@example.com' });
  script.gas.setup();
  const server = http.createServer((req, res) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
    if (req.method === 'GET') {
      res.writeHead(200, headers).end(script.gas.doGet().getContent());
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end(); // like Apps Script: no CORS preflight support
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      script.requests = (script.requests || 0) + 1;
      script.lastContentType = req.headers['content-type'];
      res.writeHead(200, headers).end(script.gas.doPost({ postData: { contents: body } }).getContent());
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, script, url: `http://127.0.0.1:${server.address().port}/exec` }));
  });
}

if (require.main === module) {
  startStandin(Number(process.argv[2]) || 8124).then(({ url }) => console.log(`Apps Script stand-in at ${url}`));
}

module.exports = { startStandin };
