import assert from 'node:assert/strict';
import { parseListeningPorts } from '../src/main/servers.mjs';
const ss = 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=777,fd=3))\nudp UNCONN 0 0 [::]:123 [::]:*\ntcp LISTEN 0 128 [::1]:8000 [::]:*';
const rows=parseListeningPorts(ss);
assert.equal(rows.length,3);assert.equal(rows[0].port,22);assert.equal(rows[0].process,'sshd');assert.equal(rows[0].pid,'777');assert.equal(rows[2].address,'[::1]');
const netstat=parseListeningPorts('tcp6 0 0 :::443 :::* LISTEN 234/nginx\nudp 0 0 127.0.0.1:53 0.0.0.0:* 45/dns');
assert.equal(netstat.length,2);assert.equal(netstat[1].process,'nginx');assert.equal(netstat[0].protocol,'UDP');
assert.deepEqual(parseListeningPorts(''),[]);
console.log('PASS ss/netstat, IPv4/IPv6, process/PID and empty output');
