import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedProxyNetworks, clientAddress } from '../src/lib/trusted-proxies.js';
import { normalizePublicBaseUrl } from '../src/lib/server-state.js';
const request=(peer,xff)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':xff}});
test('forwarded addresses require a trusted socket peer and stop at the rightmost untrusted hop',()=>{
 const trusted=trustedProxyNetworks('192.0.2.0/24,2001:db8:1::/48');
 assert.equal(clientAddress(request('192.0.2.1','203.0.113.99,198.51.100.2,192.0.2.4'),trusted),'198.51.100.2');
 assert.equal(clientAddress(request('198.51.100.1','203.0.113.1'),trusted),'198.51.100.1');
 assert.equal(clientAddress(request('192.0.2.1','198.51.100.2'),[]),'192.0.2.1');
 assert.equal(clientAddress(request('::ffff:192.0.2.1','2001:db8:2::1,2001:db8:1::3'),trusted),'2001:db8:2::1');
 for(const xff of ['invalid','198.51.100.1,','unknown','fe80::1%eth0','198.51.100.1:80',['198.51.100.1']]) assert.equal(clientAddress(request('192.0.2.1',xff),trusted),'192.0.2.1');
 assert.equal(clientAddress(request('192.0.2.1','192.0.2.2,192.0.2.3'),trusted),'192.0.2.1');
 assert.throws(()=>trustedProxyNetworks('invalid-secret'),e=>!e.message.includes('invalid-secret'));
});
test('public base URL normalization accepts HTTPS and strips trailing slashes',()=>{
 assert.equal(normalizePublicBaseUrl(' https://artifacts.example.test/// '),'https://artifacts.example.test');
 assert.throws(()=>normalizePublicBaseUrl('javascript:alert(1)'));
 assert.throws(()=>normalizePublicBaseUrl('https://user:password@example.test'));
});
