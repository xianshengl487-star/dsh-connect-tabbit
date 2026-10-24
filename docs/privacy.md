# Data handling and limitations

## Stored locally

Account records are kept at `~/.dsh/plugins/dsh-connect-tabbit/accounts.json`. The plugin applies restrictive file permissions where supported. It retains an in-memory execution copy for the running gateway and restores it from the local account pool after restart. Token-use records contain counters and bounded request metadata; they do not store prompt text or credentials.

## Sent to Tabbit

The selected Tabbit edition receives model requests and account credentials needed for authentication. When long context exceeds the web input limit, the plugin may send the full context and tool definitions as a Tabbit document attachment. This content is sent to Tabbit and may be retained there under Tabbit's own policies.

## Token and quota display

The plugin uses upstream token usage fields when they are returned. Otherwise, it shows a local text-length estimate and labels it as estimated. The estimate may omit hidden reasoning, images, server-side processing, and tokenizer differences. It is not an official usage receipt or a monetary charge. Quota and model multipliers are displayed only when the upstream provides them.

## Service boundaries

This plugin is independent software, not an official Tabbit or DSH client. Account expiry, quota exhaustion, model changes, upstream protocol changes, and service outages can interrupt requests. Tool-call compatibility depends on the selected model honoring the protocol; the plugin validates tool-call shape but cannot guarantee model behavior.
