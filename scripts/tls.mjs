import { mkdir, access, chmod, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

if (process.env.TLS_KEY && process.env.TLS_CERT) process.exit(0);
const key = '.certs/localhost-key.pem';
const cert = '.certs/localhost.pem';
if (await Promise.all([access(key), access(cert)]).then(() => true, () => false)) process.exit(0);
await mkdir('.certs', { recursive: true, mode: 0o700 });
await writeFile('.certs/openssl.cnf', `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=localhost
[ext]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-config', '.certs/openssl.cnf'], { stdio: 'ignore' });
await chmod(key, 0o600);
console.log('Created a local self-signed HTTPS certificate in .certs/. No system trust settings were changed.');
