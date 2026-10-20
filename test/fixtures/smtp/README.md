# SMTP test credentials

These self-signed certificates and the private key are public test fixtures.
Use them only to authenticate disposable loopback SMTP test servers. Never use
them for a deployed service.

The tests explicitly trust the fixture certificate. The production SMTP client
still verifies the certificate and hostname.
