# SMTP test credentials

These self-signed certificates and the private key are public test fixtures only.
They authenticate disposable loopback SMTP test servers and must never be used
for a deployed service. The tests explicitly trust the fixture certificate; the
production SMTP client retains certificate and hostname verification.
