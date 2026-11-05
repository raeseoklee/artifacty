import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedProxyNetworks, clientAddress, UNRESOLVED_CLIENT_ADDRESS } from '../src/lib/trusted-proxies.js';
import { isAddressAllowed } from '../src/lib/network-policy.js';
import { normalizePublicBaseUrl } from '../src/lib/server-state.js';
const request=(peer,xff)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':xff}});
test('forwarded addresses require a trusted socket peer and stop at the rightmost untrusted hop',()=>{
 const trusted=trustedProxyNetworks('192.0.2.0/24,2001:db8:1::/48');
 assert.equal(clientAddress(request('192.0.2.1','203.0.113.99,198.51.100.2,192.0.2.4'),trusted),'198.51.100.2');
 assert.equal(clientAddress(request('198.51.100.1','203.0.113.1'),trusted),'198.51.100.1');
 assert.equal(clientAddress(request('192.0.2.1','198.51.100.2'),[]),'192.0.2.1');
 assert.equal(clientAddress(request('::ffff:192.0.2.1','2001:db8:2::1,2001:db8:1::3'),trusted),'2001:db8:2::1');
 for(const xff of ['invalid','198.51.100.1,','unknown','fe80::1%eth0','198.51.100.1:80',['198.51.100.1'],'','x'.repeat(8193),Array(101).fill('198.51.100.1').join(',')]) assert.equal(clientAddress(request('192.0.2.1',xff),trusted),UNRESOLVED_CLIENT_ADDRESS);
 assert.equal(clientAddress(request('192.0.2.1',undefined),trusted),'192.0.2.1');
 assert.equal(clientAddress(request('192.0.2.1','192.0.2.2,192.0.2.3'),trusted),'192.0.2.1');
 assert.throws(()=>trustedProxyNetworks('invalid-secret'),e=>!e.message.includes('invalid-secret'));
});
test('public base URL normalization accepts HTTPS and strips trailing slashes',()=>{
 assert.equal(normalizePublicBaseUrl(' https://artifacts.example.test/// '),'https://artifacts.example.test');
 assert.throws(()=>normalizePublicBaseUrl('javascript:alert(1)'));
 assert.throws(()=>normalizePublicBaseUrl('https://user:password@example.test'));
});
test('client-supplied garbage left of the proxy hop cannot borrow the proxy address',()=>{
 const trusted=trustedProxyNetworks('10.0.0.5'),allowed=['10.0.0.0/8'];
 for(const xff of ['garbage, 203.0.113.9','fe80::1%eth0,203.0.113.9',',203.0.113.9']){const address=clientAddress(request('10.0.0.5',xff),trusted);assert.equal(address,'203.0.113.9');assert.equal(isAddressAllowed(address,allowed),false);}
 assert.equal(isAddressAllowed(clientAddress(request('10.0.0.5','10.0.0.9,garbage'),trusted),allowed),false,'an unusable hop must fail closed');
 assert.equal(isAddressAllowed(UNRESOLVED_CLIENT_ADDRESS,allowed),false);
 assert.equal(clientAddress(request('10.0.0.5','10.0.0.5'),trusted),'10.0.0.5');
});
