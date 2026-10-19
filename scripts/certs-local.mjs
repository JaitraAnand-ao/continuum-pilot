/* Generates the self-signed localhost certificate Compose mounts into the edge nginx
 * (scaffold SVC-7): cert.pem and key.pem in the gitignored infra/edge/certs/local/.
 * No certificate is ever committed. */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const dir = 'infra/edge/certs/local'
mkdirSync(dir, { recursive: true })
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${dir}/key.pem`,
    '-out',
    `${dir}/cert.pem`,
    '-days',
    '365',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ],
  { stdio: 'inherit' },
)
console.log(`wrote ${dir}/cert.pem and ${dir}/key.pem`)
