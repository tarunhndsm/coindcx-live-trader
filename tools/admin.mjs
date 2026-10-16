// Owner tool for the Apps Script web app. The URL and shared secret live in a private file, never in the repo.
//
//   node tools/admin.mjs pair <web app url>   create the shared secret and hand it to a freshly deployed web app
//   node tools/admin.mjs status               what the web app knows: last run, lease, triggers, book (no secrets)
//   node tools/admin.mjs config <NAME>        set GITHUB_TOKEN or OWNER_EMAIL to the value read from stdin
//   node tools/admin.mjs install              run setup(): the 15-minute schedule, the tabs and a first run
//   node tools/admin.mjs secret <NAME>        print WEBAPP_URL or WEBAPP_SECRET, for piping into `gh secret set`
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {curlFetch, webApp} from '../runner/bridge.mjs';

const FILE = process.env.TRADER_WEBAPP_FILE || path.join(os.homedir(), '.config', 'coindcx-live-trader', 'webapp.json');
const [command, arg] = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const show = (value) => console.log(JSON.stringify(value, null, 1));

if (command === 'pair') {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(arg || '')) throw new Error('give the web app URL ending in /exec');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(FILE), {recursive: true, mode: 0o700});
  fs.writeFileSync(FILE, JSON.stringify({url: arg, secret}), {mode: 0o600});
  const reply = curlFetch(arg, {method: 'post', contentType: 'text/plain', payload: JSON.stringify({op: 'pair', secret}),
                                followRedirects: true, timeoutSec: 60});
  show({code: reply.code, reply: JSON.parse(reply.body)});
} else if (command === 'secret') {
  const {url, secret} = load();
  process.stdout.write({WEBAPP_URL: url, WEBAPP_SECRET: secret}[arg]);
} else {
  const {url, secret} = load();
  const call = webApp({url, secret, http: curlFetch});
  if (command === 'status') show(call('status', {}));
  else if (command === 'install') show(call('install', {}));
  else if (command === 'config') show(call('config', {[arg]: fs.readFileSync(0, 'utf8').trim()}));
  else throw new Error('commands: pair <url>, status, config <NAME>, install, secret <NAME>');
}
