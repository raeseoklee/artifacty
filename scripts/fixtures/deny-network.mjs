// Integration-test guard inherited by Worker threads via --import.
import net from "node:net";
import http from "node:http";
import https from "node:https";
const deny = () => { throw new Error("NETWORK_FORBIDDEN_IN_OFFLINE_EMBEDDING_TEST"); };
net.Socket.prototype.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;
