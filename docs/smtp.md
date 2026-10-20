# SMTP and password reset

English | [한국어](ko/smtp.md)

## Configure email

Sign in as an administrator and open **Administration → Email / SMTP** (`/admin/email`). Enter the SMTP host, port, sender address, and TLS mode. Enable delivery when the configuration is ready.

Use the settings from your mail service. This guide does not supply provider credentials.

TLS or STARTTLS is required. Artifacty validates the server certificate and does not fall back to an insecure connection. If the username is empty, SMTP authentication is disabled and the stored password is cleared. If a username is present, leaving the password field empty keeps the existing password.

## Reset a user's password

At `/admin/users`, an administrator can reset a user's password. Artifacty generates a temporary password, requires a password change at the next login, and revokes the user's sessions. Existing API tokens are retained.

If SMTP delivery is enabled, Artifacty sends the temporary password to the user's email address. SMTP acceptance does not guarantee inbox delivery.

Artifacty does not automatically retry a failed send or a send with an uncertain outcome. The mail server may already have accepted the message. Use the temporary password shown once in the administrator result for manual delivery. Do not repeat the reset solely to retry email.

## Protect the encryption key

Artifacty encrypts the complete SMTP configuration in SQLite with AES-256-GCM. The separate key is `ARTIFACTY_HOME/secrets/smtp.key`. On POSIX systems, the directory requires mode `700` and the key file mode `600`.

Full JSON backups include the encrypted configuration but exclude its key. Upgrade snapshots also exclude the key. A restore into the same home leaves the existing key untouched. When moving or restoring into a new home, back up and transfer the original key separately with its private permissions.

If the key is lost, the encrypted configuration cannot be recovered. Restore the original key before changing settings. Do not generate a replacement key to try to decrypt the old configuration. Keep the key backup private and separate from shared backup bundles.

See [upgrade snapshots and recovery](upgrade-backups.md) for store restore procedures.
